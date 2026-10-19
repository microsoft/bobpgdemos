import { createPool } from "../dist/postgres.js";

const [productionId, stagingId] = process.argv.slice(2);
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!productionId || !stagingId || !guid.test(productionId) || !guid.test(stagingId)) {
  throw new Error("Pass the production and staging managed-identity principal IDs.");
}
const bindings = [["campsites_web", productionId], ["campsites_web_staging", stagingId]];
const roles = createPool({ ...process.env, PGDATABASE: "postgres" });
const database = createPool(process.env);
try {
  for (const [role, objectId] of bindings) {
    const existing = await roles.query("SELECT * FROM pg_catalog.pgaadauth_list_principals(false) WHERE rolname=$1", [role]);
    if (existing.rows.length) {
      const mapping = Object.entries(existing.rows[0]).find(([key]) => key.toLowerCase() === "objectid")?.[1];
      if (typeof mapping !== "string" || mapping.toLowerCase() !== objectId.toLowerCase()) {
        throw new Error(`Existing role ${role} maps to a different identity; refusing to replace it.`);
      }
    } else {
      const collision = await roles.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
      if (collision.rows.length) throw new Error(`Unmapped role ${role} already exists; refusing to modify it.`);
      await roles.query("SELECT * FROM pg_catalog.pgaadauth_create_principal_with_oid($1,$2,'service',false,false)", [role, objectId]);
    }
    await database.query(`
      GRANT CONNECT ON DATABASE campsites TO "${role}";
      GRANT USAGE ON SCHEMA escape, public TO "${role}";
      GRANT SELECT ON escape.campsite TO "${role}";
      GRANT SELECT (reservation_id,campsite_id,stay) ON escape.reservation TO "${role}";
      GRANT INSERT (campsite_id,guest_name,stay) ON escape.reservation TO "${role}";
      GRANT USAGE ON SEQUENCE escape.reservation_reservation_id_seq TO "${role}";
    `);
    const result = await database.query(`
      SELECT has_table_privilege($1,'escape.campsite','SELECT') AS read_campsites,
        has_column_privilege($1,'escape.reservation','guest_name','INSERT') AS create_booking,
        has_column_privilege($1,'escape.reservation','guest_name','SELECT') AS read_guest_names,
        has_table_privilege($1,'escape.reservation','DELETE') AS delete_bookings,
        has_table_privilege($1,'escape.reservation','UPDATE') AS update_bookings
    `, [role]);
    const rights = result.rows[0];
    if (!rights.read_campsites || !rights.create_booking || rights.read_guest_names || rights.delete_bookings || rights.update_bookings) {
      throw new Error(`Unexpected permissions for ${role}.`);
    }
    console.info(`Verified least-privilege database grants for ${role}.`);
  }
} finally {
  await Promise.all([roles.end(), database.end()]);
}
