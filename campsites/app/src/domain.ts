import { z } from "zod";

export const DEFAULTS = {
  text: "lake kayaking",
  name: "Lake Samamish Heron",
  capacity: 4,
  radius_km: 45,
  longitude: -122.335,
  latitude: 47.608,
  check_in: "2030-07-11",
  check_out: "2030-07-13",
} as const;

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const date = z.string().refine(isCalendarDate, "Use a real calendar date in YYYY-MM-DD format.");
const numberQuery = (min: number, max: number, integer = false) =>
  z.string().regex(/^-?(?:\d+(?:\.\d+)?|\.\d+)$/, "Use a finite number.")
    .transform(Number).pipe(integer ? z.number().int().min(min).max(max) : z.number().min(min).max(max));
const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");

function validStay(value: { check_in: string; check_out: string }): boolean {
  return value.check_out > value.check_in &&
    (Date.parse(value.check_out) - Date.parse(value.check_in)) / 86_400_000 <= 30;
}

export const searchSchema = z.object({
  text: z.string().trim().max(200).default(DEFAULTS.text),
  pet_friendly: booleanQuery.default(true),
  kayak_rental: booleanQuery.default(true),
  capacity: numberQuery(1, 20, true).default(DEFAULTS.capacity),
  radius_km: numberQuery(1, 200).default(DEFAULTS.radius_km),
  longitude: numberQuery(-180, 180).default(DEFAULTS.longitude),
  latitude: numberQuery(-90, 90).default(DEFAULTS.latitude),
  check_in: date.default(DEFAULTS.check_in),
  check_out: date.default(DEFAULTS.check_out),
  available_only: booleanQuery.default(true),
}).strict().refine(validStay, {
  message: "Checkout must follow check-in; stays must be at most 30 nights.",
  path: ["check_out"],
});

export const nameSearchSchema = z.object({
  name: z.string().trim().min(1).max(120).default(DEFAULTS.name),
}).strict();

export const bookingSchema = z.object({
  campsite_id: z.number().int().positive().max(2_147_483_647),
  guest_alias: z.string().trim().min(1).max(60)
    .regex(/^[\p{L}\p{N} _-]+$/u, "Use an alias containing letters, numbers, spaces, underscores or hyphens."),
  check_in: date,
  check_out: date,
}).strict().refine(validStay, {
  message: "Checkout must follow check-in; stays must be at most 30 nights.",
  path: ["check_out"],
});

export type SearchInput = z.infer<typeof searchSchema>;
export type BookingInput = z.infer<typeof bookingSchema>;

export interface Campsite {
  campsite_id: number;
  name: string;
  description: string;
  nightly_price: number;
  capacity: number;
  km_from_seattle: number;
  longitude: number;
  latitude: number;
  amenities: {
    pet_friendly: boolean;
    kayak_rental: boolean;
    electric_hookup: boolean;
    fire_pit: boolean;
    setting: string;
  };
  available: boolean;
}

export interface NameMatch {
  campsite_id: number;
  name: string;
  similarity: number;
}

export interface BookingReceipt {
  reservation_id: string;
  campsite_id: number;
  check_in: string;
  check_out: string;
}

export class RepositoryUnavailableError extends Error {}
export class BookingConflictError extends Error {}
export class CampsiteNotFoundError extends Error {}
