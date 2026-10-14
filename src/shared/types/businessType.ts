export const BUSINESS_TYPES = ['BEAUTY', 'PET_GROOMING'] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const isBusinessType = (value: unknown): value is BusinessType => {
  if (typeof value !== 'string') return false;
  return BUSINESS_TYPES.includes(value as BusinessType);
};