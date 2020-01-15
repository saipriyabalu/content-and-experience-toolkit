/**
 * Copyright (c) 2020 Oracle and/or its affiliates. All rights reserved.
 * Licensed under the Universal Permissive License v 1.0 as shown at http://oss.oracle.com/licenses/upl.
 */
/* globals app, module, __dirname */
/* jshint esversion: 6 */
var fs = require('fs'),
	path = require('path'),
	persistenceStoreApi = require('./persistenceStore').api,
	extract = require('extract-zip');
var gulp = require('gulp'),
	zip = require('gulp-zip');

// initialize the "out" folder for the persistence data
var persistenceDir = path.join(__dirname, 'out');
if (!fs.existsSync(persistenceDir)) {
	fs.mkdirSync(persistenceDir);
}
var connectorDir = path.join(persistenceDir, 'connector-data');
if (!fs.existsSync(connectorDir)) {
	fs.mkdirSync(connectorDir);
}
var compilationJobsDir = path.join(connectorDir, 'compilation-jobs');
if (!fs.existsSync(compilationJobsDir)) {
	fs.mkdirSync(compilationJobsDir);
}

/**
 * Manage persistence of the job during the jobs lifecycle. <br/>
 * This module is responsible for saving the state of the job and managing the state during startup/shutdown & failover. <br/>
 * <ul>
 *   <li>Specifically, it needs to: 
 *     <ul>
 *       <li>Keep track of all the jobs.</li>
 *       <li>For each job: 
 *         <ul>
 * 			 <li>Store metadata about the job.</li>
 *         </ul>
 *       </li>
 *     </ul>
 *   </li>
 * </ul>
 *
 * @constructor
 * @alias SampleFilePersistenceStore
 * @augments PersistenceStoreInterface
 */
var SampleFilePersistenceStore = function () {};

SampleFilePersistenceStore.prototype = Object.create(persistenceStoreApi.prototype);

/** @inheritdoc */
SampleFilePersistenceStore.prototype.getAllJobs = function () {
	var self = this;

	return new Promise(function (resolve, reject) {
		// get all the jobs
		if (fs.existsSync(compilationJobsDir)) {
			var jobDirs = fs.readdirSync(compilationJobsDir),
				allJobs = [],
				allConfigs = [];

			// Create an array of promises for all the jobs
			allJobs = jobDirs.filter(function (dirName) {
				return dirName.startsWith('job');
			}).map(function (jobId) {
				// in this persistence API, the directory name is the same as the jobId 
				// create a function to return the promise to get the job config
				return function () {
					return self.getJob({
						jobId: jobId
					}).then(function (jobConfig) {
						// store the config
						allConfigs.push(jobConfig);

						// allow promise chaining
						return Promise.resolve();
					});
				};
			});

			// now run through and get all the job configs
			// chain the promises in the array so that they execute as: p1.then(p2.then(p3.then(...)));
			var getJobConfigs = allJobs.reduce(function (previousPromise, nextPromise) {
					return previousPromise.then(function () {
						// wait for the previous promise to complete and then return a new promise for the next job config
						return nextPromise();
					});
				},
				// Start with a previousPromise value that is a resolved promise 
				Promise.resolve());

			// wait until we have all available configs
			getJobConfigs.then(function () {
				resolve(allConfigs);
			}).catch(function (error) {
				console.log('SampleFilePersistenceStore.getAllJobs(): failed to get all jobs, returning what were able to get');
				resolve(allConfigs);
			});
		} else {
			// no jobs, return empty list
			resolve([]);
		}
	});
};

//
// Job CRUD
// 
/** @inheritdoc */
SampleFilePersistenceStore.prototype.createJob = function (args) {
	return new Promise(function (resolve, reject) {
		// create a job based on the name & random ID
		var name = args.name,
			siteName = args.siteName,
			serverName = args.serverName,
			token = args.token || ''; // Optional

		// generate a random number directory for the job
		var jobId = 'job' + Math.floor(100000 + Math.random() * 900000);

		// create the job directory
		var jobDir = path.join(compilationJobsDir, jobId);
		if (!fs.existsSync(jobDir)) {
			fs.mkdirSync(jobDir);
		}

		// write out the initial data
		var jobMetadataFile = path.join(jobDir, jobId + '.json'),
			jobMetadata = {
				name: name,
				siteName: siteName,
				serverName: serverName,
				token: token,
				status: 'CREATED',
				progress: 0,
				properties: {
					id: jobId
				}
			};

		fs.writeFile(jobMetadataFile, JSON.stringify(jobMetadata), function (err) {
			if (err) {
				console.log('SampleFilePersistenceStore.createJob(): failed to write job.json file for: ' + jobId);
				reject({
					errorCode: 500,
					errorMessage: JSON.stringify(err)
				});
			} else {
				// return the generated job metadata
				resolve(jobMetadata);
			}
		});
	}).catch(function (err) {
		console.log('SampleFilePersistenceStore.createJob(): failed to create job directory for: ' + jobId);
		reject({
			errorCode: 500,
			errorMessage: JSON.stringify(err)
		});
	});
};
/** @inheritdoc */
SampleFilePersistenceStore.prototype.getJob = function (args) {
	return new Promise(function (resolve, reject) {
		// get the job folder
		var jobId = args.jobId,
			jobDir = path.join(compilationJobsDir, jobId),
			jobMetadataFile = path.join(jobDir, jobId + '.json');

		// read in the file
		if (fs.existsSync(jobMetadataFile)) {
			fs.readFile(jobMetadataFile, function (err, data) {
				if (err) {
					console.log('SampleFilePersistenceStore.getJob(): failed to read job.json file for: ' + jobId);
					reject({
						errorCode: 500,
						errorMessage: JSON.stringify(err)
					});
				} else {
					try {
						resolve(JSON.parse(data));
					} catch (parseErr) {
						console.log('SampleFilePersistenceStore.getJob(): failed to parse job.json file for: ' + jobId);
						reject({
							errorCode: 500,
							errorMessage: JSON.stringify(parseErr)
						});
					}
				}
			});
		} else {
			// no job file, reject
			var errorMessage = 'SampleFilePersistenceStore.getJob(): no job data avilable for job: ' + jobId;
			console.log(errorMessage);
			reject({
				errorCode: 404,
				errorMessage: errorMessage
			});
		}
	});
};
/** @inheritdoc */
SampleFilePersistenceStore.prototype.updateJob = function (updatedJobMetadata) {
	var self = this;

	return new Promise(function (resolve, reject) {
		// update the job
		var jobId = updatedJobMetadata.properties.id,
			jobDir = path.join(compilationJobsDir, jobId),
			jobMetadataFile = path.join(jobDir, jobId + '.json');

		self.getJob({
			jobId: jobId
		}).then(function (jobMetadata) {

			// TODO: Save code for debugging
			/*
			var updates = Object.getOwnPropertyNames(updatedJobMetadata);
			updates.map(function(key) {
				if (['name', 'siteName', 'serverName', 'token', 'status', 'progress'].indexOf(key) !== -1) {
					if (jobMetadata[key] !== updatedJobMetadata[key]) {
						console.log('updateJob property:', key, 'new value:', updatedJobMetadata[key]);
					}
				}
			});
			*/

			// write out the data
			fs.writeFile(jobMetadataFile, JSON.stringify(updatedJobMetadata), function (err) {
				if (err) {
					console.log('SampleFilePersistenceStore.updateJob(): failed to write job.json file for: ' + jobId);
					reject({
						errorCode: 500,
						errorMessage: JSON.stringify(err)
					});
				} else {
					// return the merge job object
					resolve(updatedJobMetadata);
				}
			});
		}).catch(function (err) {
			console.log('SampleFilePersistenceStore.updateJob(): failed to get job.json file for: ' + jobId);
			reject({
				errorCode: 500,
				errorMessage: JSON.stringify(err)
			});
		});
	});
};
/** @inheritdoc */
SampleFilePersistenceStore.prototype.deleteJob = function (args) {
	return new Promise(function (resolve, reject) {
		// delete the job
		var jobId = args.jobId,
			jobFilePath = path.join(compilationJobsDir, jobId);

		// delete the directory
		try {
			if (fs.existsSync(jobFilePath)) {
				var deleteFolderRecursive = function (path) {
					if (fs.existsSync(path)) {
						fs.readdirSync(path).forEach(function (file, index) {
							var curPath = path + "/" + file;
							if (fs.lstatSync(curPath).isDirectory()) {
								deleteFolderRecursive(curPath);
							} else {
								fs.unlinkSync(curPath);
							}
						});
						fs.rmdirSync(path);
					}
				};
				deleteFolderRecursive(jobFilePath);
			}
			resolve();
		} catch (err) {
			console.log('SampleFilePersistenceStore.deleteJob(): failed to delete job folder for: ' + jobId);
			reject({
				errorCode: 500,
				errorMessage: JSON.stringify(err)
			});
		}
	});
};

/** @inheritdoc */
SampleFilePersistenceStore.prototype.updateFileMetadata = function (args) {
	// just overwrite the metadata file
	return this.createFileMetadata(args);
};

/** @inheritdoc */
SampleFilePersistenceStore.prototype.getLogStream = function (args) {
	return new Promise(function (resolve, reject) {
		var jobId = args.id,
			jobDir = path.join(compilationJobsDir, jobId),
			jobLogFile = path.join(jobDir, jobId + '.log');
			// jobLogFile = path.join('/not', jobId + '-stream-log.log');

		var stream = fs.createWriteStream(jobLogFile, {'flags': 'a'});

		stream.on('error', function(err) {
			console.log('SampleFilePersistenceStore.getLogStream(): failed to create log stream for:', jobId, 'due to', err);
			reject({
				errorCode: 500,
				errorMessage: JSON.stringify(err)
			});
		});

		stream.once('open', function() {
			resolve(stream);
		});
	});
};

/** @inheritdoc */
SampleFilePersistenceStore.prototype.readLog = function (args) {
	return new Promise(function (resolve, reject) {
		var jobId = args.id,
			jobDir = path.join(compilationJobsDir, jobId),
			jobLogFile = path.join(jobDir, jobId + '.log');

		if (fs.existsSync(jobLogFile)) {
			fs.readFile(jobLogFile, 'utf8', function (err, data) {
				if (err) {
					console.log('SampleFilePersistenceStore.readLog(): failed to log file for: ' + jobId);
					reject({
						errorCode: 500,
						errorMessage: JSON.stringify(err)
					});
				} else {
					resolve(data);
				}
			});
		} else {
			// no log file, reject
			var errorMessage = 'SampleFilePersistenceStore.readLog(): no log file avilable for job: ' + jobId;
			console.log(errorMessage);
			reject({
				errorCode: 404,
				errorMessage: errorMessage
			});
		}
	});
};


// Export the persistence store 
module.exports = new SampleFilePersistenceStore();