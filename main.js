const yargs = require('yargs')
const AWS = require('aws-sdk')
const bunyan = require('bunyan')
const Promise = require('bluebird')

const log = bunyan.createLogger({ name: "delete-vpc", level: 'trace', stream: process.stderr })
const efs = new AWS.EFS({ apiVersion: '2015-02-01', region: process.env.AWS_REGION })
const ec2 = new AWS.EC2({ apiVersion: '2016-11-15' })
const elb = new AWS.ELB();

const yargsFunc = (yargs) => {
  yargs.positional('vpc-id', { describe: 'ID of the VPC', default: null })
  yargs.positional('dry-run', { describe: 'Don\' actually delete anything', default: false })
}

yargs
  .command('delete', 'Delete the VPC', yargsFunc, async (argv) => {
    await deleteEC2Instances(argv.vpcId, argv.dryRun) // Remove Instances
    await deleteELBs(argv.vpcId, argv.dryRun) // Remove Load Balancers
    await deleteInternetGateways(argv.vpcId, argv.dryRun) // Remove Internet Gateways
    // Remove EFS volumes
    await deleteNATGateways(argv.vpcId, argv.dryRun) // Remove NAT Gateways
    await deleteVPC(argv.vpcId, argv.dryRun) // Remove VPC
    return true
  })
  .argv

async function deleteEC2Instances(vpcId, DryRun) {
  this.log = log.child({ methods: 'deleteEC2Instances', vpcId });
  this.log.info('Start')
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
  let response
  try {
    response = await Promise.fromCallback(cb => ec2.terminateInstances(deleteParams, cb))
    this.log.info('Response', { response })
  } catch (err) {
    this.log.info('Error terminating instances', { Error: err.message })
  }
}

async function deleteELBs(vpcId, DryRun) {
  this.log = log.child({ methods: 'deleteELBs', vpcId });
  this.log.trace('Start')
  const elbs = await Promise.fromCallback(cb => elb.describeLoadBalancers({}, cb))
  const elbsInVPC = elbs.LoadBalancerDescriptions.filter(x => x.VPCId === vpcId)

  return await Promise.map(elbsInVPC, async (elb) => {
    const deleteParams = {
      LoadBalancerName: elb.LoadBalancerName
    }
    if (DryRun) {
      this.log.info('Dry run. Deleteing ELB', { name: elb.LoadBalancerName })
      return
    }
    return await Promise.fromCallback(cb => elb.deleteLoadBalancer(deleteParams, cb))
  })
}

async function deleteInternetGateways(VpcId, DryRun) {
  this.log = log.child({ methods: 'deleteInternetGateways', VpcId, DryRun });
  this.log.trace('Start')
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
  this.log.info('Internet Gateway Ids', { InternetGatewayIds })

  await Promise.map(InternetGatewayIds, async (InternetGatewayId) => {
    const params = { InternetGatewayId, DryRun };
    const detachParms = Object.assign({}, params, { VpcId })
    try {
      await Promise.fromCallback(cb => ec2.detachInternetGateway(detachParms, cb));
      await Promise.fromCallback(cb => ec2.deleteInternetGateway(params, cb));
    } catch (err) {
      this.log.error('Error deleting internet gateway', { Error: err.message })
    }
  })
  this.log.trace(`InternetGateways succesfuly deleted DryRun: ${DryRun}`)
  return InternetGatewayIds
}

async function deleteEFS () {}

async function deleteNATGateways(vpcId, DryRun) {
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
    try {
      await Promise.fromCallback(cb => ec2.deleteNatGateway(params, cb));
    } catch (err) {
      this.log.error('Error deleting NAT Gateway', { Error: err.message })
    }
  })
}

async function deleteVPC (VpcId, DryRun) {
  this.log = log.child({ methods: 'deleteVPC', VpcId: VpcId || 'nothing', DryRun });
  this.log.trace('Start')
  const params = { VpcId, DryRun };
  try {
    return await Promise.fromCallback(cb => ec2.deleteVpc(params, cb));
  } catch (err) {
    if (DryRun) {
      this.log.info('Error deleting VPC', { Error: err.message })
      return
    }
    this.log.error('Error deleting VPC', { Error: err.message })
  }
}
