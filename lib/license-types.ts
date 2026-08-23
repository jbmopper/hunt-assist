export type LicenseSourceKind = 'leftover' | 'reissue';

export type LicenseAccess = 'Public + private' | 'Private land only';
export type LicenseResidency =
  | 'Everyone'
  | 'Nonresident only'
  | 'Resident only';
export type LicenseSpecies =
  | 'Bighorn sheep'
  | 'Black bear'
  | 'Deer'
  | 'Elk'
  | 'Moose'
  | 'Mountain goat'
  | 'Other'
  | 'Pronghorn'
  | 'Turkey';

export type LicenseRecord = {
  access: LicenseAccess;
  code: string;
  description: string;
  list: string;
  method: string;
  methodCode: string;
  quota: number;
  residency: LicenseResidency;
  season: string;
  seasonCode: string;
  sex: string;
  species: LicenseSpecies;
  units: number[];
};

export type ParserIntegrity = {
  detectedCodes: number;
  pages: number;
  parsedCodes: number;
  parserVersion: string;
};

export type LicenseFeed = {
  fetchedAt: string;
  generatedAt: string | null;
  hunts: LicenseRecord[];
  integrity: ParserIntegrity;
  notice: string | null;
  source: {
    kind: LicenseSourceKind;
    label: string;
    officialPageUrl: string;
    pdfPageUrl: string;
  };
  stale: boolean;
  warning: string | null;
};
