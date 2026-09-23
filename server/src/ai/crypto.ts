// Moved to utils/secrets.ts so services outside ai/ (the Gmail read grant)
// can encrypt tokens without crossing the import boundary. Re-exported here
// for existing imports.
export { encryptSecret, decryptSecret, last4 } from '../utils/secrets';
