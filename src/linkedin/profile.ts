import type { Page } from "playwright";
import type { Lead } from "../leads/types.js";
import { BrowserActionError } from "../browser/types.js";
import type { ProfileInspection } from "../browser/types.js";
import { CHALLENGE_PATH, CHALLENGE_TEXT, SELECTORS } from "./selectors.js";

export interface ProfileSnapshot { url: string; heading: string | null; bodyStart: string; }

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function inspectProfileSnapshot(snapshot: ProfileSnapshot, lead: Pick<Lead, "name" | "linkedin_url">): ProfileInspection {
  const url = new URL(snapshot.url);
  if (CHALLENGE_PATH.test(url.pathname) || CHALLENGE_TEXT.test(snapshot.bodyStart)) {
    throw new BrowserActionError("auth_challenge", "LinkedIn login or verification requires human attention");
  }
  const expected = new URL(lead.linkedin_url);
  const canonical = (value: URL) => `${value.hostname.replace(/^www\./, "").toLowerCase()}${value.pathname.replace(/\/$/, "").toLowerCase()}`;
  if (canonical(url) !== canonical(expected)) throw new BrowserActionError("profile_mismatch", "Profile URL changed or target did not match");
  if (!snapshot.heading) throw new BrowserActionError("unknown_layout", "Profile heading not found");
  if (normalizeName(snapshot.heading) !== normalizeName(lead.name)) throw new BrowserActionError("profile_mismatch", "Profile name did not match lead");
  return { profileUrl: url.toString(), displayName: snapshot.heading.trim(), verified: true };
}

export async function inspectProfilePage(page: Page, lead: Lead): Promise<ProfileInspection> {
  const headingLocator = page.locator(SELECTORS.profileHeading).filter({ visible: true });
  await headingLocator.first().waitFor({ state: "visible", timeout: 7000 }).catch(() => undefined);
  const headings = (await headingLocator.allInnerTexts()).map((value) => value.trim()).filter(Boolean);
  const matches = headings.filter((value) => normalizeName(value) === normalizeName(lead.name));
  const titleName = (await page.title()).replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
  const titleMatches = headings.filter((value) => normalizeName(value) === normalizeName(titleName));
  const headingText = matches.length === 1 ? matches[0]! : titleMatches.length === 1 ? titleMatches[0]! : null;
  const bodyStart = (await page.locator("body").innerText({ timeout: 5000 })).slice(0, 2500);
  return inspectProfileSnapshot({ url: page.url(), heading: headingText, bodyStart }, lead);
}
