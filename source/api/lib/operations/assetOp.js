// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0

const AWS = (() => {
  try {
    const AWSXRay = require('aws-xray-sdk');
    return AWSXRay.captureAWS(require('aws-sdk'));
  } catch (e) {
    return require('aws-sdk');
  }
})();
const {
  CommonUtils,
  DB,
  Environment,
  StateData,
} = require('core-lib');
const JsonProvider = require('./jsonProvider');
const BaseOp = require('./baseOp');

class AssetOp extends BaseOp {
  async onGET() {
    const uuid = (this.request.pathParameters || {}).uuid;
    /* get specific record */
    if (uuid) {
      return super.onGET(await this.onGetByUuid(uuid));
    }
    const qs = this.request.queryString || {};
    const token = qs.token && decodeURIComponent(qs.token);
    if (token && !CommonUtils.validateBase64JsonToken(token)) {
      throw new Error('invalid token');
    }
    const pageSize = Number.parseInt(qs.pageSize || Environment.DynamoDB.Ingest.GSI.PageSize, 10);
    const overallStatus = qs.overallStatus && decodeURIComponent(qs.overallStatus);
    const type = qs.type && decodeURIComponent(qs.type);
    /* get records by overallStatus */
    if (overallStatus) {
      return super.onGET(await this.onGetByOverallStatus(overallStatus, token, pageSize));
    }
    /* get records by specific type */
    if (type) {
      return super.onGET(await this.onGetByType(type, token, pageSize));
    }
    /* get all records */
    return super.onGET(await this.onGetAll(token, pageSize));
  }

  async onPOST() {
    const params = this.request.body || {};
    const input = params.input;
    if (!input) {
      throw new Error('input object must be specified');
    }
    if (!(input.uuid || (input.bucket && input.key))) {
      throw new Error('uuid or bucket and key must be specified');
    }
    if (input.uuid && !CommonUtils.validateUuid(input.uuid)) {
      throw new Error('invalid uuid');
    }
    if ((input.destination || {}).bucket && !CommonUtils.validateBucket(input.destination.bucket)) {
      throw new Error('invalid destination bucket name');
    }
    /* if is JSON file, start batch ingest */
    const response = JsonProvider.isJsonFile(params.input.key)
      ? await this.batchStartIngestWorkflow(params)
      : await this.startIngestWorkflow(params);
    return super.onPOST(response);
  }

  async onDELETE() {
    const uuid = (this.request.pathParameters || {}).uuid;
    if (!uuid || !CommonUtils.validateUuid(uuid)) {
      throw new Error('invalid uuid');
    }
    const db = new DB({
      Table: Environment.DynamoDB.Ingest.Table,
      PartitionKey: Environment.DynamoDB.Ingest.PartitionKey,
    });
    await db.purge(uuid)
      .catch((e) =>
        console.error(`[ERR]: db.purge: ${uuid} ${e.code} ${e.message}`));
    return super.onDELETE({
      uuid,
      status: StateData.Statuses.Removed,
    });
  }

  async batchStartIngestWorkflow(params) {
    const input = params.input;
    const provider = await JsonProvider.createProvider(input);
    provider.parse();
    const files = provider.getFiles().slice(0);

    return Promise.all(files.map(x =>
      this.startIngestWorkflow({
        input: {
          ...input,
          ...x,
          attributes: provider.attributes,
        },
      }).catch(e => ({
        uuid: x.uuid,
        status: StateData.Statuses.Error,
        errorMessage: e.message,
      }))));
  }

  async startIngestWorkflow(params) {
    const input = params.input;
    /* #1: make sure there is no uuid collision */
    let fetched;
    if (input.uuid) {
      const db = new DB({
        Table: Environment.DynamoDB.Ingest.Table,
        PartitionKey: Environment.DynamoDB.Ingest.PartitionKey,
      });
      fetched = await db.fetch(input.uuid, undefined, 'key').catch(() => ({}));

      if (input.key && fetched.key && input.key !== fetched.key) {
        throw new Error(`${input.uuid} is already used for other asset`);
      }
    }
    /* #2: make sure s3 object exists */
    const uuid = input.uuid || CommonUtils.uuid4();
    const bucket = input.bucket || Environment.Ingest.Bucket;
    const key = input.key || fetched.key;
    await CommonUtils.headObject(bucket, key);
    /* #3: make destination params */
    input.destination = {
      bucket: Environment.Proxy.Bucket,
      prefix: CommonUtils.makeSafeOutputPrefix(uuid, key),
      ...input.destination,
    };
    /* #4: start ingest state machine */
    const arn = [
      'arn:aws:states',
      process.env.AWS_REGION,
      this.request.accountId,
      'stateMachine',
      Environment.StateMachines.Main,
    ].join(':');

    const step = new AWS.StepFunctions({
      apiVersion: '2016-11-23',
      customUserAgent: Environment.Solution.Metrics.CustomUserAgent,
    });
    return step.startExecution({
      input: JSON.stringify({
        input,
      }),
      stateMachineArn: arn,
    }).promise().then(data => ({
      uuid: params.uuid,
      status: StateData.Statuses.Started,
      ...data,
    }));
  }

  async onGetByUuid(uuid) {
    if (!CommonUtils.validateUuid(uuid)) {
      throw new Error('invalid uuid');
    }
    const db = new DB({
      Table: Environment.DynamoDB.Ingest.Table,
      PartitionKey: Environment.DynamoDB.Ingest.PartitionKey,
    });
    return db.fetch(uuid);
  }

  async onGetByOverallStatus(overallStatus, token, pageSize) {
    const db = new DB({
      Table: Environment.DynamoDB.Ingest.Table,
      PartitionKey: Environment.DynamoDB.Ingest.PartitionKey,
    });
    return db.scanIndex({
      Name: Environment.DynamoDB.Ingest.GSI.Status.Name,
      Key: Environment.DynamoDB.Ingest.GSI.Status.Key,
      Value: overallStatus,
      Token: token,
      PageSize: pageSize,
      Ascending: false,
    });
  }

  async onGetByType(type, token, pageSize) {
    const params = (type === 'group')
      ? {
        Name: Environment.DynamoDB.Ingest.GSI.Group.Name,
        Key: Environment.DynamoDB.Ingest.GSI.Group.Key,
      }
      : {
        Name: Environment.DynamoDB.Ingest.GSI.Type.Name,
        Key: Environment.DynamoDB.Ingest.GSI.Type.Key,
      };
    const db = new DB({
      Table: Environment.DynamoDB.Ingest.Table,
      PartitionKey: Environment.DynamoDB.Ingest.PartitionKey,
    });
    return db.scanIndex({
      ...params,
      Value: type,
      Token: token,
      PageSize: pageSize,
      Ascending: false,
    });
  }

  async onGetAll(token, pageSize) {
    const db = new DB({
      Table: Environment.DynamoDB.Ingest.Table,
      PartitionKey: Environment.DynamoDB.Ingest.PartitionKey,
    });
    return db.scanIndex({
      Name: Environment.DynamoDB.Ingest.GSI.SchemaVersion.Name,
      Key: Environment.DynamoDB.Ingest.GSI.SchemaVersion.Key,
      Value: Environment.DynamoDB.Ingest.GSI.SchemaVersion.Value,
      Token: token,
      PageSize: pageSize,
      Ascending: false,
    });
  }
}

module.exports = AssetOp;
