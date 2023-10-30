import type {
  Option,
  Struct,
  bool,
  u32,
  UInt,
  U8aFixed
} from '@polkadot/types';
import { ApiOptions } from '@polkadot/api/types';

export interface Index extends u32 {}

export interface Balance extends UInt {}

export interface H160 extends U8aFixed {}

export interface H256 extends U8aFixed {}

export interface EvmAccountInfo extends Struct {
  readonly nonce: Index;
  readonly contractInfo: Option<EvmContractInfo>;
  readonly developerDeposit: Option<Balance>;
}

export interface EvmContractInfo extends Struct {
  readonly codeHash: H256;
  readonly maintainer: H160;
  readonly deployed: bool;
}

export declare const defaultOptions: ApiOptions;
export declare const options: ({
  types,
  rpc,
  typesAlias,
  typesBundle,
  signedExtensions,
  ...otherOptions
}?: ApiOptions) => ApiOptions;
