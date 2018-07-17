#!/usr/bin/env node

const yargs = require('yargs')
const AWS = require('aws-sdk')
const bunyan = require('bunyan')
const Promise = require('bluebird')
const _ = require('lodash')

let log

const efs = new AWS.EFS({ apiVersion: '2015-02-01', region: process.env.AWS_REGION })
const ec2 = new AWS.EC2({ apiVersion: '2016-11-15' })
const elb = new AWS.ELB();

const yargsFunc = (yargs) => {
  yargs.positional('vpc-id', { describe: 'ID of the VPC', default: null })
  // TODO: Implement on all functions
  // yargs.positional('dry-run', { describe: 'Don\' actually delete anything', default: false })
}

yargs
  .command('delete [vpc-id]', 'Delete the VPC and all dependencies', yargsFunc, async (argv) => {
    const stream = argv.logToStdout ? process.stdout : process.stderr
    log = bunyan.createLogger({ name: "delete-vpc", level: argv.logLevel, stream  })
    // TODO: This should get all resources it deleted and print them out to STDOUT
    await deleteEC2Instances(argv.vpcId, argv.dryRun) // Remove Instances
    await deleteELBs(argv.vpcId, argv.dryRun) // Remove Load Balancers
    await deleteEFS(argv.vpcId, argv.dryRun) // Remove EFS volumes
    // Remove Elastic IPs
    await deleteNATGateways(argv.vpcId, argv.dryRun) // Remove NAT Gateways
    await deleteNetworkInterfaces(argv.vpcId, argv.dryRun) // Remove Network Interfaces
    await deleteSecurityGroups(argv.vpcId, argv.dryRun) // Remove Instances
    await deleteInternetGateways(argv.vpcId, argv.dryRun) // Remove Internet Gateways
    await deleteSubnets(argv.vpcId, argv.dryRun)
    await deleteRouteTables(argv.vpcId, argv.dryRun)
    await deleteVPC(argv.vpcId, argv.dryRun) // Remove VPC
    console.log('VPC Deleted')
    return true
  })
  .option('log-level', { describe: 'Log level (debug, trace, info, warn, error)', default: 'error' })
  .option('log-to-stdout', { describe: 'Output logs to STDOUT instead of STDERR', default: false })
  .argv

async function deleteEC2Instances(vpcId, DryRun) {
  this.log = log.child({ methods: 'deleteEC2Instances', vpcId });
  this.log.trace('Start deleting EC2 instances')
  const filterParams = {
    Filters: [
    {
      Name: 'vpc-id',
      Values: [ vpcId ]
    }]
  }
  this.log.trace('Filter Params', { filterParams })
  const reservations = await Promise.fromCallback(cb => ec2.describeInstances(filterParams, cb))
  const instancesMap = reservations.Reservations.reduce((accumulator, current) => {
    current.Instances.forEach(i => { accumulator[i.InstanceId] = i })
    return accumulator
  }, {})
  const InstanceIds = Object.keys(instancesMap)
  this.log.trace('Instances', { InstanceIds })
  if (InstanceIds.length === 0) {
    this.log.trace('No instances to delete')
    return []
  }
  const deleteParams = { InstanceIds, DryRun }
  this.log.trace('DeleteParams', { deleteParams })
  return $(ec2, 'terminateInstances', deleteParams)
}

async function deleteELBs(vpcId, DryRun) {
  this.log = log.child({ methods: 'deleteELBs', vpcId });
  this.log.trace('Start')
  const elbs = await Promise.fromCallback(cb => elb.describeLoadBalancers({}, cb))
  const elbsInVPC = elbs.LoadBalancerDescriptions.filter(x => x.VPCId === vpcId)

  return await Promise.map(elbsInVPC, async (elbInstance) => {
    const deleteParams = {
      LoadBalancerName: elbInstance.LoadBalancerName
    }
    if (DryRun) {
      this.log.info('Dry run. Deleteing ELB', { name: elbInstance.LoadBalancerName })
      return
    }
    return await $(elb, 'deleteLoadBalancer', deleteParams)
  })
}

async function deleteInternetGateways(VpcId, DryRun) {
  this.log = log.child({ methods: 'deleteInternetGateways', VpcId, DryRun });
  this.log.trace('Start deleting internet gateways')
  const params = {
    Filters: [
      {
        Name: "attachment.vpc-id",
        Values: [ VpcId ]
      }
    ]
  };
  const response = await Promise.fromCallback(cb => ec2.describeInternetGateways(params, cb))
  const InternetGatewayIds = response.InternetGateways.map(x => x.InternetGatewayId)
  this.log.trace('Internet Gateway Ids', { InternetGatewayIds })

  await Promise.map(InternetGatewayIds, async (InternetGatewayId) => {
    const params = { InternetGatewayId, DryRun };
    const detachParams = Object.assign({}, params, { VpcId })
    await $(ec2, 'detachInternetGateway', detachParams)
    await $(ec2, 'deleteInternetGateway', params)
  })
  this.log.trace(`InternetGateways succesfuly deleted DryRun: ${DryRun}`)
  return InternetGatewayIds
}

async function deleteEFS (vpcId, DryRun) {
  this.log = log.child({ methods: 'deleteEFS', vpcId, DryRun });
  this.log.trace('Start deleting EFS Filesystems')
  const response = await Promise.fromCallback(cb => efs.describeFileSystems({}, cb))
  const fileSystemIds = response.FileSystems.map(x => x.FileSystemId)
  this.log.trace('fileSystemIds', { fileSystemIds })
  const mountTargets = await Promise.reduce(fileSystemIds, async (memo, FileSystemId) => {
    const params = { FileSystemId }
    const response = await Promise.fromCallback(cb => efs.describeMountTargets(params, cb))
    this.log.trace('memoLength', { length: memo.length, super: response.MountTargets.length })
    return [].concat(memo).concat(response.MountTargets)
  }, [])
  const subnetIds = await getSubnetIds(vpcId)
  this.log.trace('mountTargets', { mountTargets })
  this.log.trace('subnetIds', { subnetIds })
  const mountTargetsToBeDeleted = mountTargets.filter(x => {
    this.log.trace('SubnetId', { SubnetId: x.SubnetId })
    return subnetIds.includes(x.SubnetId)
  })
  this.log.trace('mountTargetsToBeDeleted', { mountTargetsToBeDeleted })
  const fileSystemsToBeDeleted = _.uniq(mountTargetsToBeDeleted.map(x => x.FileSystemId))
  this.log.trace('fileSystemsToBeDeleted', { fileSystemsToBeDeleted })
  await Promise.map(mountTargetsToBeDeleted, async (mountTarget) => {
    const params = { MountTargetId: mountTarget.MountTargetId }
    this.log.trace('Delete File System', { params })
    return await $(efs, 'deleteMountTarget', params)
  })
  // NOTE: This will delete any EFS with a mount target in the subet. Very greedy
  // Ideally it would only delete EFS with all mount targets in a VPC
  await Promise.delay(3000)
  await Promise.map(fileSystemsToBeDeleted, async (FileSystemId) => {
    const params = { FileSystemId }
    this.log.trace('Delete File System', { FileSystemId })
    return await $(efs, 'deleteFileSystem', params, { retryErrorCodes: 'FileSystemInUse', retries: 10 })
  })
}

async function deleteNATGateways(vpcId, DryRun) {
  this.log = log.child({ methods: 'deleteNATGateways', vpcId, DryRun });
  this.log.trace('Start deleting NAT Gateways')
  const params = {
    Filter: [
      {
        Name: "vpc-id",
        Values: [ vpcId ]
      }
    ]
  };
  const response = await Promise.fromCallback(cb => ec2.describeNatGateways(params, cb))
  const NatGatewayIds = response.NatGateways.map(x => x.NatGatewayId)

  return await Promise.map(NatGatewayIds, async (NatGatewayId) => {
    const params = { NatGatewayId };
    await $(ec2, 'deleteNatGateway', params)
  })
}

async function getSubnetIds (vpcId) {
  const params = {
    Filters: [{
      Name: "vpc-id",
      Values: [ vpcId ]
    }]
  };
  const subnetResponse = await Promise.fromCallback(cb => ec2.describeSubnets(params, cb))
  return subnetResponse.Subnets.map(x => x.SubnetId)
}

async function deleteSubnets (VpcId, DryRun) {
  this.log = log.child({ methods: 'deleteSubnets', VpcId, DryRun });
  this.log.trace('Start deleting subnets')
  const params = { VpcId, DryRun };
  const subnetIds = await getSubnetIds(VpcId)
  this.log.trace('SubnetIds', { subnetIds })
  await Promise.delay(3000)
  await Promise.map(subnetIds, async (SubnetId) => {
    const params = {SubnetId, DryRun}
    this.log.trace('Deleting subnet', { SubnetId })
    await $(ec2, 'deleteSubnet', params, { retryErrorCodes: 'DependencyViolation' })
  })
}

async function deleteVPC (VpcId, DryRun) {
  this.log = log.child({ methods: 'deleteVPC', VpcId: VpcId || 'nothing', DryRun });
  this.log.trace('Start deleting VPC')
  const params = { VpcId, DryRun };
  await $(ec2, 'deleteVpc', params, { allowedErrorCodes: 'InvalidVpcID.NotFound' })
  this.log.info('VPC Deleted')
}

async function deleteSecurityGroups (vpcId, DryRun) {
  var params = {
    DryRun,
    Filters: [{
      Name: 'vpc-id',
      Values: [ vpcId ]
    }]
  }
  const securityGroups = (await Promise.fromCallback(cb => ec2.describeSecurityGroups(params, cb))).SecurityGroups;
  this.log.trace('Security Groups', { securityGroups })
  await Promise.mapSeries(securityGroups, async (securityGroup) => {
    this.log.trace('Security group', { securityGroup,   })
    await Promise.mapSeries(securityGroup.IpPermissions, async (ruleUnfiltered) => {
      const rule = {}
      rule.GroupId = securityGroup.GroupId
      if (!_.isEmpty(ruleUnfiltered.IpRanges)) {
        const ipRange = ruleUnfiltered.IpRanges[0]
        rule.IpProtocol = ruleUnfiltered.IpProtocol
        rule.FromPort = ruleUnfiltered.FromPort
        rule.ToPort = ruleUnfiltered.ToPort
        rule.CidrIp = ipRange.CidrIp
      }
      if (!_.isEmpty(ruleUnfiltered.UserIdGroupPairs)) {
        rule.IpPermissions = [ _.pick(ruleUnfiltered, ['IpProtocol', 'UserIdGroupPairs', 'FromPort', 'ToPort']) ]
      }
      this.log.trace('Delete Ingress Rule', { rule, ruleUnfiltered })
      await $(ec2, 'revokeSecurityGroupIngress', rule)
    })
    return
  })
  const sgIds = securityGroups.filter(x => x.GroupName !== 'default').map(x => x.GroupId)
  this.log.trace('Security Group Ids', { sgIds })
  await Promise.delay(1000)
  await Promise.map(sgIds, async function (GroupId) {
    const params = { GroupId, DryRun }
    return await $(ec2, 'deleteSecurityGroup', params)
  })
}

async function deleteNetworkInterfaces (VpcId, DryRun) {
  this.log = log.child({ methods: 'deleteNetworkInterfaces', VpcId });
  const queryParams = {
    DryRun,
    Filters: [
      {
        Name: 'vpc-id',
        Values: [ VpcId ]
      }
    ]
  };
  const response = await Promise.fromCallback(cb => ec2.describeNetworkInterfaces(queryParams, cb))
  const networkInterfaceIds = response.NetworkInterfaces.map(x => x.NetworkInterfaceId)
  const networkInterfaceAttachmentIds = response.NetworkInterfaces.map(x => _.get(x, 'Attachment.AttachmentId')).filter(x => !!x)
  await Promise.map(networkInterfaceAttachmentIds, async (AttachmentId) => {
    const detachParams = { AttachmentId, Force: true, DryRun }
    await $(ec2, 'detachNetworkInterface', detachParams, { allowedErrorCodes: 'OperationNotPermitted' })
  })
  await Promise.map(networkInterfaceIds, async (NetworkInterfaceId) => {
    const deleteParams = { DryRun, NetworkInterfaceId }
    return $(ec2, 'deleteNetworkInterface', deleteParams, { allowedErrorCodes: 'InvalidNetworkInterfaceID.NotFound' })
  })
}

async function deleteRouteTables (VpcId, DryRun) {
  const queryParams = {
    DryRun,
    Filters: [
      {
        Name: 'vpc-id',
        Values: [ VpcId ]
      },
    ]
  }
  const response = await Promise.fromCallback(cb => ec2.describeRouteTables(queryParams, cb))
  // TODO: This should filter out the default route table
  const routeTableIds = response.RouteTables.map(x => x.RouteTableId)
  return await Promise.map(routeTableIds, async (RouteTableId) => {
    const query = { RouteTableId, DryRun }
    return $(ec2, 'deleteRouteTable', query, { allowedErrorCodes: 'DependencyViolation' })
  })
}

async function $(classInstance, methodName, query, opts = {}) {
  this.log = log.child({ methods: '$', endpoint: classInstance.endpoint.host, methodName, query, opts });
  const className = classInstance.endpoint.host.split('.')[0]
  let result
  try {
    result = await Promise.fromCallback(cb => classInstance[methodName](query, cb))
  } catch (err) {
    if (opts.retryErrorCodes && opts.retryErrorCodes.includes(err.code)) {
      opts.retries = ((_.isNumber(opts.retries) ? opts.retries : 6) - 1)
      if (opts.retries <= 0) {
        this.log.error('No retries left', { retries: opts.retries, errorCode: err.code })
        throw err
      }
      this.log.trace('Retrying', { retries: opts.retries, errorCode: err.code })
      await Promise.delay(opts.retryDelay || 2000)
      return $(classInstance, methodName, query, opts)
    }
    if (opts.allowedErrorCodes && opts.allowedErrorCodes.includes(err.code)) {
      this.log.trace('Allowed Error', { errorCode: err.code })
      return
    }
    this.log.error(`Error executing ${className}.${methodName}`, { errorCode: err.code })
    throw err
  }
  return result
}
