import type { Schema } from '../../types';

/**
 * Structural validators (no validation library in the project). Shapes match
 * what migration 045 backfilled: config = non-secret settings, credentials =
 * `{ access_token }`.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const nonEmpty = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

export interface WhatsAppCloudConfig {
  waba_id: string;
  verify_token?: string;
  mirror_inbound_media?: boolean;
  [key: string]: unknown;
}

export interface WhatsAppCloudCredentials {
  access_token: string;
}

export const whatsappCloudConfigSchema: Schema<WhatsAppCloudConfig> = {
  safeParse(input) {
    if (!isRecord(input)) {
      return { success: false, error: 'config must be an object' };
    }
    if (!nonEmpty(input.waba_id)) {
      return { success: false, error: 'waba_id is required' };
    }
    if (input.verify_token !== undefined && !nonEmpty(input.verify_token)) {
      return {
        success: false,
        error: 'verify_token must be a non-empty string',
      };
    }
    if (
      input.mirror_inbound_media !== undefined &&
      typeof input.mirror_inbound_media !== 'boolean'
    ) {
      return {
        success: false,
        error: 'mirror_inbound_media must be a boolean',
      };
    }
    return { success: true, data: input as WhatsAppCloudConfig };
  },
};

export const whatsappCloudCredentialsSchema: Schema<WhatsAppCloudCredentials> =
  {
    safeParse(input) {
      if (!isRecord(input) || !nonEmpty(input.access_token)) {
        return { success: false, error: 'access_token is required' };
      }
      return { success: true, data: { access_token: input.access_token } };
    },
  };
