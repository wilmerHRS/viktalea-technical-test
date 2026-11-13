export const Currency = { PEN: 'PEN' } as const;
export type Currency = (typeof Currency)[keyof typeof Currency];
export const SUPPORTED_CURRENCIES: readonly Currency[] = Object.values(Currency);
