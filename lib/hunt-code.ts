import type { LicenseRecord, LicenseSpecies } from './license-types';

const SPECIES_BY_CODE: Record<string, LicenseSpecies> = {
  A: 'Pronghorn',
  B: 'Black bear',
  D: 'Deer',
  E: 'Elk',
  G: 'Mountain goat',
  M: 'Moose',
  S: 'Bighorn sheep',
  T: 'Turkey',
};

const SEX_BY_CODE: Record<string, string> = {
  E: 'Either sex',
  F: 'Female / antlerless',
  M: 'Male / antlered',
};

const METHOD_BY_CODE: Record<string, string> = {
  A: 'Archery',
  M: 'Muzzleloader',
  R: 'Rifle / associated methods',
  X: 'Special methods',
};

export function decodeHuntCode(
  code: string,
): Pick<
  LicenseRecord,
  'method' | 'methodCode' | 'seasonCode' | 'sex' | 'species'
> {
  const methodCode = code[7] ?? '';
  return {
    method: METHOD_BY_CODE[methodCode] ?? 'See brochure',
    methodCode,
    seasonCode: code[6] ?? '',
    sex: SEX_BY_CODE[code[1]] ?? 'See brochure',
    species: SPECIES_BY_CODE[code[0]] ?? 'Other',
  };
}
