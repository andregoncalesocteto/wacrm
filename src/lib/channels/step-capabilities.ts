/**
 * Client-safe (TYPES only from ./types): which flow nodes / automation steps
 * need a channel capability, and which of the account's active connections
 * cannot run them. Used for the INFORMATIONAL warning shown when a flow or
 * automation is edited/activated (US-051). It never blocks anything: at run
 * time an incompatible step fails visibly (sendOutbound -> `unsupported`).
 */
import type { ProviderCapabilities } from './composer-capabilities';
import type { MediaKind } from './types';

/** A capability a step needs; `media` carries the kind being sent. */
export type StepRequirement =
  | { capability: 'templates' }
  | { capability: 'interactiveButtons' }
  | { capability: 'interactiveList' }
  | { capability: 'media'; mediaKind: MediaKind };

export interface StepNodeLike {
  node_type?: string;
  step_type?: string;
  config?: unknown;
  step_config?: unknown;
  branches?: { yes: StepNodeLike[]; no: StepNodeLike[] };
}

const MEDIA_KINDS: MediaKind[] = ['image', 'video', 'document', 'audio'];

function requirementFor(
  type: string | undefined,
  config: unknown
): StepRequirement | null {
  switch (type) {
    case 'send_template':
      return { capability: 'templates' };
    case 'send_buttons':
      // Automations use one send_buttons/send_list pair; flows the same names.
      return { capability: 'interactiveButtons' };
    case 'send_list':
      return { capability: 'interactiveList' };
    case 'send_media': {
      const kind = (config as { media_type?: string } | null)?.media_type;
      return MEDIA_KINDS.includes(kind as MediaKind)
        ? { capability: 'media', mediaKind: kind as MediaKind }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Requirements of a flow's nodes or an automation's steps (recurses into
 * condition branches). Steps needing nothing special (text, tags, ...) are
 * omitted. Duplicates collapse: one entry per distinct requirement.
 */
export function stepRequirements(steps: StepNodeLike[]): StepRequirement[] {
  const seen = new Map<string, StepRequirement>();
  const visit = (list: StepNodeLike[]) => {
    for (const s of list) {
      const req = requirementFor(
        s.node_type ?? s.step_type,
        s.config ?? s.step_config
      );
      if (req) {
        seen.set(
          req.capability === 'media'
            ? `media:${req.mediaKind}`
            : req.capability,
          req
        );
      }
      if (s.branches) {
        visit(s.branches.yes ?? []);
        visit(s.branches.no ?? []);
      }
    }
  };
  visit(steps);
  return [...seen.values()];
}

export interface ChannelWarning {
  requirement: StepRequirement;
  /** channel_type values of active connections that cannot run the step. */
  channelTypes: string[];
}

function supports(
  req: StepRequirement,
  caps: ProviderCapabilities['capabilities']
): boolean {
  if (req.capability === 'media')
    return caps.mediaKinds.includes(req.mediaKind);
  return caps[req.capability] === true;
}

/**
 * Steps that will NOT work on some of the account's ACTIVE connections
 * (`activeChannelTypes` = one channel_type per enabled connection).
 * Nothing to say (empty list) with fewer than two active connections or when
 * every active connection supports every step, so a WhatsApp-only account
 * sees no change. A connection whose provider is unknown counts as
 * incapable. `providers` null (not loaded) yields no warnings.
 */
export function channelWarnings(
  requirements: StepRequirement[],
  providers: ProviderCapabilities[] | null | undefined,
  activeChannelTypes: string[]
): ChannelWarning[] {
  if (!providers || activeChannelTypes.length < 2) return [];
  const types = [...new Set(activeChannelTypes)];
  const warnings: ChannelWarning[] = [];
  for (const requirement of requirements) {
    const channelTypes = types.filter((type) => {
      const caps = providers.find((p) => p.type === type)?.capabilities;
      return !caps || !supports(requirement, caps);
    });
    if (channelTypes.length > 0) warnings.push({ requirement, channelTypes });
  }
  return warnings;
}
