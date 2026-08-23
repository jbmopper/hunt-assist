import { decodeHuntCode } from './hunt-code';
import type { LicenseRecord } from './license-types';

type SampleHunt = Pick<
  LicenseRecord,
  | 'access'
  | 'code'
  | 'description'
  | 'list'
  | 'quota'
  | 'residency'
  | 'season'
  | 'units'
>;

function sampleHunt(input: SampleHunt): LicenseRecord {
  return { ...input, ...decodeHuntCode(input.code) };
}

export const SAMPLE_HUNTS: LicenseRecord[] = [
  sampleHunt({
    access: 'Public + private',
    code: 'EF011O4R',
    description: '',
    list: 'A',
    quota: 1544,
    residency: 'Everyone',
    season: '11/18/2026 - 11/22/2026',
    units: [11, 12, 13, 23, 24, 211],
  }),
  sampleHunt({
    access: 'Public + private',
    code: 'BE034O1R',
    description: '',
    list: 'B',
    quota: 167,
    residency: 'Everyone',
    season: '09/02/2026 - 09/30/2026',
    units: [34],
  }),
  sampleHunt({
    access: 'Public + private',
    code: 'DE104O3M',
    description: 'WHITETAIL ONLY',
    list: 'A',
    quota: 11,
    residency: 'Everyone',
    season: '10/10/2026 - 10/18/2026',
    units: [104, 105, 106],
  }),
  sampleHunt({
    access: 'Public + private',
    code: 'AF106O1R',
    description: '',
    list: 'B',
    quota: 111,
    residency: 'Everyone',
    season: '10/03/2026 - 10/11/2026',
    units: [106],
  }),
  sampleHunt({
    access: 'Private land only',
    code: 'EE015P3R',
    description: 'PRIVATE LAND ONLY',
    list: 'A',
    quota: 16,
    residency: 'Everyone',
    season: '11/07/2026 - 11/15/2026',
    units: [15],
  }),
];
