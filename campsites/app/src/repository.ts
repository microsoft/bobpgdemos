import {
  RepositoryUnavailableError,
  type BookingInput, type BookingReceipt, type Campsite, type NameMatch, type SearchInput,
} from "./domain.js";

/**
 * Implement against the existing escape schema, never seed or migrate on startup.
 * Bound results to 100 campsites / 3 name matches; use parameterized SQL.
 * Search uses websearch_to_tsquery, JSONB containment, ST_DWithin (km * 1000),
 * and NOT EXISTS over reservation.stay && daterange(check_in, check_out, '[)').
 * Sort campsites by distance then name; name matches by similarity DESC then name.
 * book maps guest_alias to guest_name internally. INSERT atomically; translate
 * SQLSTATE 23P01 to BookingConflictError and a missing campsite to CampsiteNotFoundError.
 * Never select, return, or log another reservation's guest_name.
 */
export interface CampsiteRepository {
  ready(): Promise<boolean>;
  search(input: SearchInput): Promise<readonly Campsite[]>;
  searchNames(name: string): Promise<readonly NameMatch[]>;
  book(input: BookingInput): Promise<BookingReceipt>;
}

export class UnconfiguredRepository implements CampsiteRepository {
  async ready(): Promise<boolean> { return false; }
  async search(_input: SearchInput): Promise<readonly Campsite[]> {
    throw new RepositoryUnavailableError();
  }
  async searchNames(_name: string): Promise<readonly NameMatch[]> {
    throw new RepositoryUnavailableError();
  }
  async book(_input: BookingInput): Promise<BookingReceipt> {
    throw new RepositoryUnavailableError();
  }
}
