/* eslint-disable @typescript-eslint/no-unused-vars */
import type {
  Block,
  BlockTag,
  BlockWithTransactions,
  EventType,
  FeeData,
  Filter,
  Listener,
  Log,
  Provider as AbstractProvider,
  TransactionReceipt,
  TransactionRequest,
  TransactionResponse
} from '@ethersproject/abstract-provider';
import { isHexString } from '@ethersproject/bytes';
import { Deferrable, resolveProperties } from '@ethersproject/properties';
import { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { Logger } from '@ethersproject/logger';
import type { Network } from '@ethersproject/networks';
import Scanner from './scanner/Scanner';
import { ApiPromise } from '@polkadot/api';
import { ApiOptions } from '@polkadot/api/types';
import type { WsProvider } from '@polkadot/rpc-provider';
import { Option } from '@polkadot/types';
import {
  hexToU8a,
  isHex,
  isNumber,
  numberToHex,
  u8aConcat,
  u8aFixLength
} from '@polkadot/util';
import { encodeAddress } from '@polkadot/util-crypto';
import '@polkadot/api-augment';
import type BN from 'bn.js';

import { AbstractDataProvider } from './DataProvider';
import { resolveAddress, resolveEvmAddress, toBN } from './utils';
import { options } from './reef-api/options';
import { EvmAccountInfo, EvmContractInfo } from './types';

const logger = new Logger('evm-provider');
export class Provider implements AbstractProvider {
  readonly api: ApiPromise;
  readonly resolveApi: Promise<ApiPromise>;
  readonly _isProvider: boolean;
  readonly dataProvider?: AbstractDataProvider;
  readonly scanner: Scanner;

  /**
   *
   * @param _apiOptions
   * @param dataProvider
   */
  constructor(_apiOptions: ApiOptions, dataProvider?: AbstractDataProvider) {
    const apiOptions = options(_apiOptions);

    this.api = new ApiPromise(apiOptions);

    this.resolveApi = this.api.isReady;
    this._isProvider = true;

    this.dataProvider = dataProvider;
    this.scanner = new Scanner({
      wsProvider: apiOptions.provider as WsProvider,
      types: apiOptions.types,
      typesAlias: apiOptions.typesAlias,
      typesSpec: apiOptions.typesSpec,
      typesChain: apiOptions.typesChain,
      typesBundle: apiOptions.typesBundle
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
  static isProvider(value: any): boolean {
    return !!(value && value._isProvider);
  }

  async init(): Promise<void> {
    await this.api.isReady;
    this.dataProvider && (await this.dataProvider.init());
  }

  /**
   * Get the network the provider is connected to.
   * @returns A promise resolving to the name and chain ID of the connected chain.
   */
  async getNetwork(): Promise<Network> {
    await this.resolveApi;

    return {
      name: this.api.runtimeVersion.specName.toString(),
      chainId: 13939
    };
  }

  /**
   * Get the block number of the chain's head.
   * @returns A promise resolving to the block number of the head block.
   */
  async getBlockNumber(): Promise<number> {
    await this.resolveApi;

    const r = await this.api.rpc.chain.getHeader();

    return r.number.toNumber();
  }

  async getGasPrice(): Promise<BigNumber> {
    // return logger.throwError(`Unsupport getGasPrice`);
    return BigNumber.from(0);
  }

  async getFeeData(): Promise<FeeData> {
    return {
      maxFeePerGas: BigNumber.from(1),
      maxPriorityFeePerGas: BigNumber.from(1),
      gasPrice: BigNumber.from(1)
    };
  }

  /**
   * Get an account's balance by address or name.
   * @param addressOrName The address or name of the account
   * @param blockTag The block to get the balance of, defaults to the head
   * @returns A promise resolving to the account's balance
   */
  async getBalance(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<BigNumber> {
    await this.resolveApi;

    let address = await resolveAddress(this, addressOrName);

    if (!address) {
      address = await this._toAddress(addressOrName);
    }

    const blockHash = await this._resolveBlockHash(blockTag);

    const accountInfo = blockHash
      ? await this.api.query.system.account.at(blockHash, address)
      : await this.api.query.system.account(address);

    return BigNumber.from(accountInfo.data.free.toBn().toString());
  }

  /**
   * Get the transaction count of an account at a specified block.
   * @param addressOrName The address or name of the account
   * @param blockTag The block to get the transaction count of, defaults to the head block
   * @returns A promise resolving to the account's transaction count
   */
  async getTransactionCount(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<number> {
    await this.resolveApi;

    const resolvedBlockTag = await blockTag;

    const address = await resolveEvmAddress(this, addressOrName);

    let account: Option<EvmAccountInfo>;

    if (resolvedBlockTag === 'pending') {
      account = await this.api.query.evm.accounts<Option<EvmAccountInfo>>(
        address
      );
    } else {
      const blockHash = await this._resolveBlockHash(blockTag);

      account = blockHash
        ? await this.api.query.evm.accounts.at<Option<EvmAccountInfo>>(
            blockHash,
            address
          )
        : await this.api.query.evm.accounts<Option<EvmAccountInfo>>(address);
    }

    if (!account.isNone) {
      return account.unwrap().nonce.toNumber();
    } else {
      return 0;
    }
  }

  /**
   * Get the code hash at a given address
   * @param addressOrName The address of the code
   * @param blockTag The block to look up the address, defaults to latest
   * @returns A promise resolving in the code hash
   */
  async getCode(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<string> {
    await this.resolveApi;

    const { address, blockHash } = await resolveProperties({
      address: resolveEvmAddress(this, addressOrName),
      blockHash: this._getBlockTag(blockTag)
    });

    const contractInfo = await this.queryContractInfo(address, blockHash);

    if (contractInfo.isNone) {
      return '0x';
    }

    const codeHash = contractInfo.unwrap().codeHash;
    const api = await (blockHash ? this.api.at(blockHash) : this.api);
    const code = await api.query.evm.codes(codeHash);

    return code.toHex();
  }

  async _getBlockTag(blockTag?: BlockTag | Promise<BlockTag>): Promise<string> {
    blockTag = await blockTag;

    if (blockTag === undefined) {
      blockTag = 'latest';
    }

    switch (blockTag) {
      case 'pending': {
        return logger.throwError(
          'pending tag not implemented',
          Logger.errors.UNSUPPORTED_OPERATION
        );
      }
      case 'latest': {
        const hash = await this.api.rpc.chain.getBlockHash();
        return hash.toHex();
      }
      case 'earliest': {
        const hash = this.api.genesisHash;
        return hash.toHex();
      }
      default: {
        if (!isHexString(blockTag)) {
          return logger.throwArgumentError(
            'blocktag should be a hex string',
            'blockTag',
            blockTag
          );
        }

        // block hash
        if (typeof blockTag === 'string' && isHexString(blockTag, 32)) {
          return blockTag;
        }

        const blockNumber = BigNumber.from(blockTag).toNumber();

        const hash = await this.api.rpc.chain.getBlockHash(blockNumber);

        return hash.toHex();
      }
    }
  }

  async queryAccountInfo(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<Option<EvmAccountInfo>> {
    // pending tag
    const resolvedBlockTag = await blockTag;
    if (resolvedBlockTag === 'pending') {
      const address = await resolveEvmAddress(this, addressOrName);
      return this.api.query.evm.accounts<Option<EvmAccountInfo>>(address);
    }

    const { address, blockHash } = await resolveProperties({
      address: resolveEvmAddress(this, addressOrName),
      blockHash: this._getBlockTag(blockTag)
    });

    const apiAt = await this.api.at(blockHash);

    const accountInfo = await apiAt.query.evm.accounts<Option<EvmAccountInfo>>(
      address
    );

    return accountInfo;
  }

  async queryContractInfo(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<Option<EvmContractInfo>> {
    const accountInfo = await this.queryAccountInfo(addressOrName, blockTag);

    if (accountInfo.isNone) {
      return this.api.createType<Option<EvmContractInfo>>(
        'Option<EvmContractInfo>',
        null
      );
    }

    return accountInfo.unwrap().contractInfo;
  }

  /**
   * Get the storage from a block.
   * @param addressOrName The address to retrieve the storage from
   * @param position
   * @param blockTag The block to retrieve the storage from, defaults to head
   * @returns The storage data as a hash
   */
  async getStorageAt(
    addressOrName: string | Promise<string>,
    position: BigNumberish | Promise<BigNumberish>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<string> {
    await this.resolveApi;

    const address = await resolveEvmAddress(this, addressOrName);
    const blockHash = await this._resolveBlockHash(blockTag);

    const code = blockHash
      ? await this.api.query.evm.accountStorages.at(blockHash, address)
      : await this.api.query.evm.accountStorages(address);

    return code.toHex();
  }

  /**
   * Unimplemented
   */
  async sendTransaction(
    signedTransaction: string | Promise<string>
  ): Promise<TransactionResponse> {
    return this._fail('sendTransaction');
  }

  /**
   * Submit a transaction to be executed on chain.
   * @param transaction The transaction to call
   * @param blockTag
   * @returns The call result as a hash
   */
  async call(
    transaction: Deferrable<TransactionRequest>,
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<string> {
    const resolved = await this._resolveTransaction(transaction);
    if (blockTag) {
      const blockHash = await this._resolveBlockHash(blockTag);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (this.api.rpc as any).evm.call(resolved, blockHash);
      return result.toHex();
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (this.api.rpc as any).evm.call({
        to: resolved.to,
        from: resolved.from,
        data: resolved.data,
        storageLimit: '0'
      });
      return result.toHex();
    }
  }

  /**
   * Estimate gas for a transaction.
   * @param transaction The transaction to estimate the gas of
   * @returns The estimated gas used by this transaction
   */
  async estimateGas(
    transaction: Deferrable<TransactionRequest>
  ): Promise<BigNumber> {
    const resources = await this.estimateResources(transaction);
    return resources.gas.add(resources.storage);
  }

  /**
   * Estimate resources for a transaction.
   * @param transaction The transaction to estimate the resources of
   * @returns The estimated resources used by this transaction
   */
  async estimateResources(
    transaction: Deferrable<TransactionRequest>
  ): Promise<{
    gas: BigNumber;
    storage: BigNumber;
    weightFee: BigNumber;
  }> {
    const resolved = await this._resolveTransaction(transaction);

    const from = await resolved.from;
    const value = await resolved.value;
    const to = await resolved.to;
    const data = await resolved.data;
    const storageLimit = await this._resolveStorageLimit(resolved);

    if (!from) {
      return logger.throwError('From cannot be undefined');
    }

    // construct extrinsic to estimate
    const extrinsic = !to
      ? this.api.tx.evm.create(
          data,
          toBN(value),
          toBN(await resolved.gasLimit),
          toBN(storageLimit)
        )
      : this.api.tx.evm.call(
          to,
          data,
          toBN(value),
          toBN(await resolved.gasLimit),
          toBN(storageLimit)
        );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (this.api.rpc as any).evm.estimateResources(
      resolved.from,
      extrinsic.toHex() // returns transaction bytecode?
    );

    return {
      gas: BigNumber.from((result.gas as BN).toString()),
      storage: BigNumber.from((result.storage as BN).toString()),
      weightFee: BigNumber.from((result.weightFee as BN).toString())
    };
  }

  /**
   * Unimplemented, will always fail.
   */
  async getBlock(
    blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>
  ): Promise<Block> {
    return this._fail('getBlock');
  }

  /**
   * Unimplemented, will always fail.
   */
  async getBlockWithTransactions(
    blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>
  ): Promise<BlockWithTransactions> {
    return this._fail('getBlockWithTransactions');
  }

  /**
   * Unimplemented, will always fail.
   */
  async getTransaction(transactionHash: string): Promise<TransactionResponse> {
    return this._fail('getTransaction');
  }

  async getTransactionReceipt(txHash: string): Promise<TransactionReceipt> {
    if (!this.dataProvider) return this._fail('getTransactionReceipt');
    return this.dataProvider.getTransactionReceipt(
      txHash,
      this._resolveBlockNumber
    );
  }

  async resolveName(name: string | Promise<string>): Promise<string> {
    return name;
  }

  async lookupAddress(address: string | Promise<string>): Promise<string> {
    return address;
  }

  /**
   * Unimplemented, will always fail.
   */
  async waitForTransaction(
    transactionHash: string,
    confirmations?: number,
    timeout?: number
  ): Promise<TransactionReceipt> {
    return this._fail('waitForTransaction');
  }

  /**
   * Get an array of filtered logs from the chain's head.
   * @param filter The filter to apply to the logs
   * @returns A promise that resolves to an array of filtered logs
   */
  async getLogs(filter: Filter): Promise<Array<Log>> {
    if (!this.dataProvider) return this._fail('getLogs');
    return this.dataProvider.getLogs(filter, this._resolveBlockNumber);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _fail(operation: string): Promise<any> {
    return Promise.resolve().then(() => {
      logger.throwError(`Unsupport ${operation}`);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(eventName: EventType, ...args: Array<any>): boolean {
    return logger.throwError('Unsupport Event');
  }

  listenerCount(eventName?: EventType): number {
    return logger.throwError('Unsupport Event');
  }

  listeners(eventName?: EventType): Array<Listener> {
    return logger.throwError('Unsupport Event');
  }

  off(eventName: EventType, listener?: Listener): AbstractProvider {
    return logger.throwError('Unsupport Event');
  }

  on(eventName: EventType, listener: Listener): AbstractProvider {
    return logger.throwError('Unsupport Event');
  }

  once(eventName: EventType, listener: Listener): AbstractProvider {
    return logger.throwError('Unsupport Event');
  }

  removeAllListeners(eventName?: EventType): AbstractProvider {
    return logger.throwError('Unsupport Event');
  }

  addListener(eventName: EventType, listener: Listener): AbstractProvider {
    return this.on(eventName, listener);
  }

  removeListener(eventName: EventType, listener: Listener): AbstractProvider {
    return this.off(eventName, listener);
  }

  async _resolveTransactionReceipt(
    transactionHash: string,
    blockHash: string,
    from: string
  ): Promise<TransactionReceipt> {
    const detail = await this.scanner.getBlockDetail({
      blockHash: blockHash
    });

    const blockNumber = detail.number;
    const extrinsic = detail.extrinsics.find(
      ({ hash }) => hash === transactionHash
    );

    if (!extrinsic) {
      return logger.throwError(`Transaction hash not found`);
    }

    const transactionIndex = extrinsic.index;

    const events = detail.events.filter(
      ({ phaseIndex }) => phaseIndex === transactionIndex
    );

    const findCreated = events.find(
      (x) =>
        x.section.toUpperCase() === 'EVM' &&
        x.method.toUpperCase() === 'CREATED'
    );

    const findExecuted = events.find(
      (x) =>
        x.section.toUpperCase() === 'EVM' &&
        x.method.toUpperCase() === 'EXECUTED'
    );

    const result = events.find(
      (x) =>
        x.section.toUpperCase() === 'SYSTEM' &&
        x.method.toUpperCase() === 'EXTRINSICSUCCESS'
    );

    if (!result) {
      return logger.throwError(`Can't find event`);
    }

    const status = findCreated || findExecuted ? 1 : 0;

    const contractAddress = findCreated ? findCreated.args[0] : null;

    const to = findExecuted ? findExecuted.args[0] : null;

    const logs = events
      .filter((e) => {
        return (
          e.method.toUpperCase() === 'LOG' && e.section.toUpperCase() === 'EVM'
        );
      })
      .map((log, index) => {
        return {
          transactionHash,
          blockNumber,
          blockHash,
          transactionIndex,
          removed: false,
          address: log.args[0].address,
          data: log.args[0].data,
          topics: log.args[0].topics,
          logIndex: index
        };
      });

    const gasUsed = BigNumber.from(result.args[0].weight);

    return {
      to,
      from,
      contractAddress,
      transactionIndex,
      gasUsed,
      logsBloom: '0x',
      blockHash,
      transactionHash,
      logs,
      blockNumber,
      confirmations: 4,
      cumulativeGasUsed: gasUsed,
      byzantium: false,
      status,
      effectiveGasPrice: BigNumber.from('1'),
      type: 0
    };
  }

  async _resolveBlockHash(
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<string> {
    await this.resolveApi;

    if (!blockTag) return undefined;

    const resolvedBlockHash = await blockTag;

    if (resolvedBlockHash === 'pending') {
      throw new Error('Unsupport Block Pending');
    }

    if (resolvedBlockHash === 'latest') {
      const hash = await this.api.query.system.blockHash();
      return hash.toString();
    }

    if (resolvedBlockHash === 'earliest') {
      const hash = this.api.query.system.blockHash(0);
      return hash.toString();
    }

    if (isHex(resolvedBlockHash)) {
      return resolvedBlockHash;
    }

    const hash = await this.api.query.system.blockHash(resolvedBlockHash);

    return hash.toString();
  }

  async _resolveBlockNumber(
    blockTag?: BlockTag | Promise<BlockTag>
  ): Promise<number> {
    await this.resolveApi;

    if (!blockTag) {
      return logger.throwError(`Blocktag cannot be undefined`);
    }

    const resolvedBlockNumber = await blockTag;

    if (resolvedBlockNumber === 'pending') {
      throw new Error('Unsupport Block Pending');
    }

    if (resolvedBlockNumber === 'latest') {
      const header = await this.api.rpc.chain.getHeader();
      return header.number.toNumber();
    }

    if (resolvedBlockNumber === 'earliest') {
      return 0;
    }

    if (isNumber(resolvedBlockNumber)) {
      return resolvedBlockNumber;
    } else {
      throw new Error('Expect blockHash to be a number or tag');
    }
  }

  async _toAddress(addressOrName: string | Promise<string>): Promise<string> {
    const resolved = await addressOrName;
    const address = encodeAddress(
      u8aFixLength(u8aConcat('evm:', hexToU8a(resolved)), 256, true)
    );
    return address.toString();
  }

  async _resolveTransaction(
    tx: Deferrable<TransactionRequest>
  ): Promise<Deferrable<TransactionRequest>> {
    for (const key of ['gasLimit', 'value']) {
      const typeKey = key as 'gasLimit' | 'value';

      if (tx[typeKey]) {
        if (BigNumber.isBigNumber(tx[typeKey])) {
          tx[typeKey] = (tx[typeKey] as BigNumber).toHexString();
        } else if (isNumber(tx[typeKey])) {
          tx[typeKey] = numberToHex(tx[typeKey] as number);
        }
      }
    }

    delete tx.nonce;
    delete tx.gasPrice;
    delete tx.chainId;

    return tx;
  }

  async _resolveStorageLimit(
    tx: Deferrable<TransactionRequest>
  ): Promise<BigNumber> {
    if (tx.customData) {
      if ('storageLimit' in tx.customData) {
        const storageLimit = tx.customData.storageLimit;
        if (BigNumber.isBigNumber(storageLimit)) {
          return storageLimit;
        } else if (isNumber(storageLimit)) {
          return BigNumber.from(storageLimit);
        }
      }
    }

    // At least 60 REEF are needed to deploy
    return BigNumber.from(60_000);
  }
}
