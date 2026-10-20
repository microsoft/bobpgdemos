import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import {
  bookingSchema, nameSearchSchema, searchSchema,
  BookingConflictError, CampsiteNotFoundError, RepositoryUnavailableError,
} from "./domain.js";
import { type CampsiteRepository, UnconfiguredRepository } from "./repository.js";
import { bookingQuery, executionDetails, nameQuery, searchQuery } from "./queries.js";

interface RateOptions { max: number; windowMs: number }
interface AppOptions {
  repository?: CampsiteRepository;
  publicOrigin?: string;
  trustProxy?: number | false;
  readRate?: RateOptions;
  writeRate?: RateOptions;
  now?: () => number;
  log?: (event: string) => void;
}

function rateLimit(options: RateOptions, now: () => number): RequestHandler {
  const buckets = new Map<string, { count: number; reset: number }>();
  return (req, res, next) => {
    const time = now();
    for (const [key, bucket] of buckets) if (bucket.reset <= time) buckets.delete(key);
    const key = req.ip ?? "unknown";
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 10_000) {
        res.set("Retry-After", "60").status(429).json({ error: "Too many requests. Please try again shortly." });
        return;
      }
      bucket = { count: 0, reset: time + options.windowMs };
      buckets.set(key, bucket);
    }
    if (++bucket.count > options.max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.reset - time) / 1000))))
        .status(429).json({ error: "Too many requests. Please try again shortly." });
      return;
    }
    next();
  };
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const repository = options.repository ?? new UnconfiguredRepository();
  const log = options.log ?? ((event: string) => console.error(event));
  const now = options.now ?? Date.now;
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy ?? false);
  app.use(helmet({
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", "https://tile.openstreetmap.org", "data:"],
        fontSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  }));
  app.use(cors({
    origin: false,
    credentials: false,
  }));
  app.get("/healthz", (_req, res) => { res.json({ status: "ok" }); });
  app.get("/readyz", async (_req, res) => {
    try {
      const ready = await repository.ready();
      res.set("Cache-Control", "no-store").status(ready ? 200 : 503)
        .json({ status: ready ? "ready" : "not_ready" });
    } catch {
      log("readiness_failed");
      res.set("Cache-Control", "no-store").status(503).json({ status: "not_ready" });
    }
  });
  app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const readLimiter = rateLimit(options.readRate ?? { max: 120, windowMs: 60_000 }, now);
  const writeLimiter = rateLimit(options.writeRate ?? { max: 10, windowMs: 60_000 }, now);
  app.get("/api/campsites", readLimiter, async (req, res) => {
    const result = searchSchema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({ error: "Invalid search filters.", issues: result.error.issues.map((issue) => ({
        field: issue.path.join("."), message: issue.message,
      })) });
      return;
    }
    const query = searchQuery(result.data);
    const started = performance.now();
    const sites = await repository.search(result.data);
    const execution = executionDetails(query, started, Math.min(sites.length, 100));
    res.json({ campsites: sites.slice(0, 100).map((site) => ({
      campsite_id: site.campsite_id, name: site.name, description: site.description,
      nightly_price: site.nightly_price, capacity: site.capacity, km_from_seattle: site.km_from_seattle,
      available: site.available,
      longitude: site.longitude, latitude: site.latitude,
      amenities: {
        pet_friendly: site.amenities.pet_friendly, kayak_rental: site.amenities.kayak_rental,
        electric_hookup: site.amenities.electric_hookup, fire_pit: site.amenities.fire_pit,
        setting: site.amenities.setting,
      },
    })), execution });
  });
  app.get("/api/name-search", readLimiter, async (req, res) => {
    const result = nameSearchSchema.safeParse(req.query);
    if (!result.success) { res.status(400).json({ error: "Provide a name of 1–120 characters." }); return; }
    const query = nameQuery(result.data.name);
    const started = performance.now();
    const matches = await repository.searchNames(result.data.name);
    const execution = executionDetails(query, started, Math.min(matches.length, 3));
    res.json({ matches: matches.slice(0, 3).map((match) => ({
      campsite_id: match.campsite_id, name: match.name, similarity: match.similarity,
    })), execution });
  });
  app.post("/api/bookings", writeLimiter, (req, res, next) => {
    const expected = options.publicOrigin ?? `${req.protocol}://${req.get("host")}`;
    if (req.get("origin") !== expected || req.get("sec-fetch-site") === "cross-site") {
      res.status(403).json({ error: "Bookings must come from this site's own page." });
      return;
    }
    if (!req.is("application/json")) {
      res.status(415).json({ error: "Send an application/json request." });
      return;
    }
    next();
  }, express.json({ limit: "8kb", strict: true }), async (req, res) => {
    const result = bookingSchema.safeParse(req.body as unknown);
    if (!result.success) {
      res.status(400).json({ error: "Invalid booking. Use an alias and a valid stay of 1–30 nights.",
        issues: result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })) });
      return;
    }
    const query = bookingQuery(result.data);
    const started = performance.now();
    try {
      const receipt = await repository.book(result.data);
      res.status(201).json({ booking: {
        reservation_id: receipt.reservation_id, campsite_id: receipt.campsite_id,
        check_in: receipt.check_in, check_out: receipt.check_out,
      }, execution: executionDetails(query, started, 1) });
    } catch (error) {
      if (!(error instanceof BookingConflictError)) throw error;
      res.status(409).json({
        error: "Those dates have just been booked. Choose another stay.",
        execution: executionDetails(query, started, 0, "overlap rejected (SQLSTATE 23P01)"),
      });
    }
  });
  app.use("/api", (_req, res) => { res.status(404).json({ error: "API route not found." }); });
  for (const asset of ["leaflet.js", "leaflet.css"]) {
    app.get(`/vendor/${asset}`, (_req, res) => {
      res.sendFile(fileURLToPath(new URL(`../node_modules/leaflet/dist/${asset}`, import.meta.url)));
    });
  }
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), {
    index: "index.html", dotfiles: "deny",
  }));
  app.use((_req, res) => { res.status(404).json({ error: "Page not found." }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof BookingConflictError) {
      res.status(409).json({ error: "Those dates have just been booked. Choose another stay." });
    } else if (error instanceof CampsiteNotFoundError) {
      res.status(404).json({ error: "Campsite not found." });
    } else if (error instanceof RepositoryUnavailableError) {
      log("repository_unavailable");
      res.status(503).json({ error: "Campsite data is temporarily unavailable. Please try again later." });
    } else if (typeof error === "object" && error !== null && "type" in error &&
      error.type === "entity.too.large") {
      res.status(413).json({ error: "Request body is too large." });
    } else if (typeof error === "object" && error !== null && "type" in error &&
      error.type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body must be valid JSON." });
    } else {
      log("request_failed");
      res.status(500).json({ error: "Something went wrong. Please try again later." });
    }
  };
  app.use(errors);
  return app;
}
