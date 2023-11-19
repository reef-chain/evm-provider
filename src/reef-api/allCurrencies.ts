import { ApiInterfaceRx } from '@polkadot/api/types';
import { memo } from '@polkadot/api-derive/util';
import { Observable, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { Vec } from '@polkadot/types';
import type { Enum, U8aFixed } from '@polkadot/types-codec';
import type { ITuple } from '@polkadot/types-codec/types';

/** @name TokenSymbol */
export interface TokenSymbol extends Enum {
  readonly isReef: boolean;
  readonly isRusd: boolean;
  readonly type: 'Reef' | 'Rusd';
}

/** @name H160 */
export interface H160 extends U8aFixed {}

/** @name EvmAddress */
export interface EvmAddress extends H160 {}

/** @name CurrencyId */
export interface CurrencyId extends Enum {
  readonly isToken: boolean;
  readonly asToken: TokenSymbol;
  readonly isDexShare: boolean;
  readonly asDexShare: ITuple<[TokenSymbol, TokenSymbol]>;
  readonly isErc20: boolean;
  readonly asErc20: EvmAddress;
  readonly type: 'Token' | 'DexShare' | 'Erc20';
}

function getNativeCurrencyId(api: ApiInterfaceRx): Observable<CurrencyId> {
  return api.rpc.system.properties().pipe(
    switchMap((properties) => {
      const nativeTokenSymbol = properties.tokenSymbol
        .unwrapOrDefault()[0]
        .toString();

      return of(
        api.registry.createType(
          'CurrencyId',
          api.registry.createType('TokenSymbol', nativeTokenSymbol)
        )
      );
    })
  );
}

/**
 * @name nativeCurrencyId
 * @returns native currencyId
 */
export function nativeCurrencyId(
  instanceId: string,
  api: ApiInterfaceRx
): () => Observable<CurrencyId> {
  return memo(instanceId, () => {
    return getNativeCurrencyId(api);
  });
}

/**
 * @name stakingCurrencyId
 * @returns staking currencyId in staking pool
 */

function getAllNonNativeCurrencyIds(api: ApiInterfaceRx): Vec<CurrencyId> {
  return api.consts.transactionPayment
    .allNonNativeCurrencyIds as unknown as Vec<CurrencyId>;
}

/**
 * @name allNonNativeCurrencyIds
 * @returns all nonnative currencyIds
 */
export function allNonNativeCurrencyIds(
  instanceId: string,
  api: ApiInterfaceRx
): () => Observable<Vec<CurrencyId>> {
  return memo(instanceId, () => {
    return of(getAllNonNativeCurrencyIds(api));
  });
}

/**
 * @name allCurrencyIds
 * @returns all currencyIds includes stable currencyId and all nonnative currencyIds
 */
export function allCurrencyIds(
  instanceId: string,
  api: ApiInterfaceRx
): () => Observable<CurrencyId[]> {
  return memo(instanceId, () => {
    return getNativeCurrencyId(api).pipe(
      switchMap((nativeCurrencyId) => {
        return of([
          nativeCurrencyId,
          ...getAllNonNativeCurrencyIds(api).slice()
        ]);
      })
    );
  });
}
