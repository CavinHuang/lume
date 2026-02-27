/**
 * AIEOS v1.1 身份格式支持
 * 参考 ZeroClaw identity.rs 实现
 */

export interface AieosIdentity {
  identity?: {
    names?: { first?: string; last?: string; nickname?: string; full?: string };
    bio?: string;
    origin?: string;
    residence?: string;
  };
  psychology?: {
    mbti?: string;
    ocean?: { openness?: number; conscientiousness?: number; extraversion?: number; agreeableness?: number; neuroticism?: number };
    neural_matrix?: Record<string, number>;
    moral_compass?: string[];
  };
  linguistics?: {
    style?: string;
    formality?: string;
    catchphrases?: string[];
    forbidden_words?: string[];
  };
  motivations?: {
    core_drive?: string;
    short_term_goals?: string[];
    long_term_goals?: string[];
    fears?: string[];
  };
  capabilities?: { skills?: string[]; tools?: string[] };
  physicality?: { appearance?: string; avatar_description?: string };
  history?: { origin_story?: string; education?: string[]; occupation?: string };
  interests?: { hobbies?: string[]; favorites?: Record<string, string>; lifestyle?: string };
}

function toText(val: unknown): string | undefined {
  if (typeof val === "string") return val.trim() || undefined;
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) {
    const items = val.map((v) => toText(v)).filter(Boolean);
    return items.length > 0 ? items.join(", ") : undefined;
  }
  return undefined;
}

function toList(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map((v) => toText(v)).filter((v): v is string => !!v);
  if (typeof val === "string" && val.trim()) return [val.trim()];
  return [];
}

export function parseAieos(json: string): AieosIdentity {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const id = raw.identity as Record<string, unknown> | undefined;
    const psych = raw.psychology as Record<string, unknown> | undefined;
    const ling = raw.linguistics as Record<string, unknown> | undefined;
    const mot = raw.motivations as Record<string, unknown> | undefined;
    const cap = raw.capabilities as Record<string, unknown> | undefined;
    const phys = raw.physicality as Record<string, unknown> | undefined;
    const hist = raw.history as Record<string, unknown> | undefined;
    const inter = raw.interests as Record<string, unknown> | undefined;

    const names = id?.names as Record<string, unknown> | undefined;
    const ocean = (psych?.ocean ?? (psych?.traits as Record<string, unknown> | undefined)?.ocean) as Record<string, unknown> | undefined;
    const mbti = toText(psych?.mbti ?? (psych?.traits as Record<string, unknown> | undefined)?.mbti);

    return {
      identity: id ? {
        names: names ? {
          first: toText(names.first),
          last: toText(names.last),
          nickname: toText(names.nickname),
          full: toText(names.full) ?? (names.first && names.last ? `${names.first} ${names.last}` : undefined)
        } : undefined,
        bio: toText(id.bio),
        origin: toText(id.origin),
        residence: toText(id.residence)
      } : undefined,
      psychology: psych ? {
        mbti,
        ocean: ocean ? {
          openness: typeof ocean.openness === "number" ? ocean.openness : undefined,
          conscientiousness: typeof ocean.conscientiousness === "number" ? ocean.conscientiousness : undefined,
          extraversion: typeof ocean.extraversion === "number" ? ocean.extraversion : undefined,
          agreeableness: typeof ocean.agreeableness === "number" ? ocean.agreeableness : undefined,
          neuroticism: typeof ocean.neuroticism === "number" ? ocean.neuroticism : undefined
        } : undefined,
        moral_compass: toList(psych.moral_compass)
      } : undefined,
      linguistics: ling ? {
        style: toText(ling.style),
        formality: toText(ling.formality),
        catchphrases: toList(ling.catchphrases),
        forbidden_words: toList(ling.forbidden_words)
      } : undefined,
      motivations: mot ? {
        core_drive: toText(mot.core_drive),
        short_term_goals: toList(mot.short_term_goals ?? (mot.goals as Record<string, unknown> | undefined)?.short_term),
        long_term_goals: toList(mot.long_term_goals ?? (mot.goals as Record<string, unknown> | undefined)?.long_term),
        fears: toList(mot.fears)
      } : undefined,
      capabilities: cap ? { skills: toList(cap.skills), tools: toList(cap.tools) } : undefined,
      physicality: phys ? { appearance: toText(phys.appearance), avatar_description: toText(phys.avatar_description) } : undefined,
      history: hist ? { origin_story: toText(hist.origin_story), education: toList(hist.education), occupation: toText(hist.occupation) } : undefined,
      interests: inter ? {
        hobbies: toList(inter.hobbies),
        lifestyle: toText(inter.lifestyle)
      } : undefined
    };
  } catch {
    return {};
  }
}

export function aieosToSystemPrompt(identity: AieosIdentity): string {
  const lines: string[] = [];

  const id = identity.identity;
  if (id) {
    lines.push("## Identity\n");
    const n = id.names;
    if (n?.first) lines.push(`**Name:** ${n.full ?? n.first}${n.nickname ? ` (${n.nickname})` : ""}`);
    if (id.bio) lines.push(`**Bio:** ${id.bio}`);
    if (id.origin) lines.push(`**Origin:** ${id.origin}`);
    if (id.residence) lines.push(`**Residence:** ${id.residence}`);
    lines.push("");
  }

  const psych = identity.psychology;
  if (psych) {
    lines.push("## Personality\n");
    if (psych.mbti) lines.push(`**MBTI:** ${psych.mbti}`);
    const o = psych.ocean;
    if (o) {
      lines.push("**OCEAN Traits:**");
      if (o.openness != null) lines.push(`- Openness: ${o.openness.toFixed(2)}`);
      if (o.conscientiousness != null) lines.push(`- Conscientiousness: ${o.conscientiousness.toFixed(2)}`);
      if (o.extraversion != null) lines.push(`- Extraversion: ${o.extraversion.toFixed(2)}`);
      if (o.agreeableness != null) lines.push(`- Agreeableness: ${o.agreeableness.toFixed(2)}`);
      if (o.neuroticism != null) lines.push(`- Neuroticism: ${o.neuroticism.toFixed(2)}`);
    }
    if (psych.moral_compass?.length) {
      lines.push("\n**Moral Compass:**");
      psych.moral_compass.forEach((p) => lines.push(`- ${p}`));
    }
    lines.push("");
  }

  const ling = identity.linguistics;
  if (ling) {
    lines.push("## Communication Style\n");
    if (ling.style) lines.push(`**Style:** ${ling.style}`);
    if (ling.formality) lines.push(`**Formality:** ${ling.formality}`);
    if (ling.catchphrases?.length) {
      lines.push("**Catchphrases:**");
      ling.catchphrases.forEach((p) => lines.push(`- "${p}"`));
    }
    if (ling.forbidden_words?.length) {
      lines.push("\n**Avoid:**");
      ling.forbidden_words.forEach((w) => lines.push(`- ${w}`));
    }
    lines.push("");
  }

  const mot = identity.motivations;
  if (mot) {
    lines.push("## Motivations\n");
    if (mot.core_drive) lines.push(`**Core Drive:** ${mot.core_drive}`);
    if (mot.short_term_goals?.length) {
      lines.push("**Short-term Goals:**");
      mot.short_term_goals.forEach((g) => lines.push(`- ${g}`));
    }
    if (mot.long_term_goals?.length) {
      lines.push("\n**Long-term Goals:**");
      mot.long_term_goals.forEach((g) => lines.push(`- ${g}`));
    }
    if (mot.fears?.length) {
      lines.push("\n**Fears:**");
      mot.fears.forEach((f) => lines.push(`- ${f}`));
    }
    lines.push("");
  }

  const cap = identity.capabilities;
  if (cap) {
    lines.push("## Capabilities\n");
    if (cap.skills?.length) { lines.push("**Skills:**"); cap.skills.forEach((s) => lines.push(`- ${s}`)); }
    if (cap.tools?.length) { lines.push("\n**Tools:**"); cap.tools.forEach((t) => lines.push(`- ${t}`)); }
    lines.push("");
  }

  return lines.join("\n").trim();
}
