import { and, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  DeleteVehicleParams,
  GetInventorySummaryResponse,
  ImportVehiclesBody,
  ImportVehiclesResponse,
  ListVehiclesQueryParams,
  ListVehiclesResponse,
  UpdateVehicleBody,
  UpdateVehicleParams,
  UpdateVehicleResponse,
} from "@workspace/api-zod";
import { db, vehiclesTable } from "@workspace/db";

const router: IRouter = Router();

function normalizeRegistration(value: string): string | null {
  const registrationNumber = value.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z]{3}\d{2}[A-Z0-9]$/.test(registrationNumber)
    ? registrationNumber
    : null;
}

router.get("/vehicles", async (req, res): Promise<void> => {
  const parsed = ListVehiclesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const filters = [];
  if (parsed.data.status === "on_site") {
    filters.push(eq(vehiclesTable.onSite, true));
  } else if (parsed.data.status === "off_site") {
    filters.push(eq(vehiclesTable.onSite, false));
  }
  if (parsed.data.keysStatus) {
    filters.push(eq(vehiclesTable.keysStatus, parsed.data.keysStatus));
  }
  if (parsed.data.search?.trim()) {
    const search = parsed.data.search.trim().toUpperCase().replace(/[\s-]/g, "");
    filters.push(ilike(vehiclesTable.registrationNumber, `%${search}%`));
  }

  const rows = await db
    .select()
    .from(vehiclesTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(vehiclesTable.updatedAt), vehiclesTable.registrationNumber)
    .limit(5000);

  res.json(ListVehiclesResponse.parse(rows));
});

router.post("/vehicles/import", async (req, res): Promise<void> => {
  const parsed = ImportVehiclesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const uniqueRegistrations = new Set<string>();
  let existing = 0;
  let invalid = 0;

  for (const rawRegistration of parsed.data.registrations) {
    const registrationNumber = normalizeRegistration(rawRegistration);
    if (!registrationNumber) {
      invalid += 1;
      continue;
    }
    if (uniqueRegistrations.has(registrationNumber)) {
      existing += 1;
      continue;
    }
    uniqueRegistrations.add(registrationNumber);
  }

  const registrations = [...uniqueRegistrations];
  const existingRows = registrations.length
    ? await db
        .select({ registrationNumber: vehiclesTable.registrationNumber })
        .from(vehiclesTable)
        .where(inArray(vehiclesTable.registrationNumber, registrations))
    : [];
  const alreadyInInventory = new Set(
    existingRows.map((row) => row.registrationNumber),
  );
  existing += alreadyInInventory.size;

  const toCreate = registrations
    .filter((registrationNumber) => !alreadyInInventory.has(registrationNumber))
    .map((registrationNumber) => ({ registrationNumber }));
  const createdRows = toCreate.length
    ? await db
        .insert(vehiclesTable)
        .values(toCreate)
        .onConflictDoNothing()
        .returning()
    : [];

  existing += toCreate.length - createdRows.length;
  res.json(
    ImportVehiclesResponse.parse({
      created: createdRows.length,
      existing,
      invalid,
      vehicles: createdRows,
    }),
  );
});

router.patch(
  "/vehicles/:registrationNumber",
  async (req, res): Promise<void> => {
    const parsedParams = UpdateVehicleParams.safeParse(req.params);
    const parsedBody = UpdateVehicleBody.safeParse(req.body);
    if (!parsedParams.success) {
      res.status(400).json({ error: parsedParams.error.message });
      return;
    }
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.message });
      return;
    }

    if (
      parsedBody.data.onSite === undefined &&
      parsedBody.data.keysStatus === undefined
    ) {
      res.status(400).json({ error: "Provide presence or key status to update." });
      return;
    }

    const registrationNumber = normalizeRegistration(
      parsedParams.data.registrationNumber,
    );
    if (!registrationNumber) {
      res.status(400).json({ error: "Invalid Swedish registration number." });
      return;
    }

    const update: Partial<typeof vehiclesTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (parsedBody.data.onSite !== undefined) {
      update.onSite = parsedBody.data.onSite;
      update.onSiteAt = parsedBody.data.onSite ? new Date() : null;
    }
    if (parsedBody.data.keysStatus !== undefined) {
      update.keysStatus = parsedBody.data.keysStatus;
    }

    const [vehicle] = await db
      .update(vehiclesTable)
      .set(update)
      .where(eq(vehiclesTable.registrationNumber, registrationNumber))
      .returning();

    if (!vehicle) {
      res.status(404).json({ error: "Vehicle not found." });
      return;
    }
    res.json(UpdateVehicleResponse.parse(vehicle));
  },
);

router.delete(
  "/vehicles/:registrationNumber",
  async (req, res): Promise<void> => {
    const parsed = DeleteVehicleParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const registrationNumber = normalizeRegistration(
      parsed.data.registrationNumber,
    );
    if (!registrationNumber) {
      res.status(400).json({ error: "Invalid Swedish registration number." });
      return;
    }

    const [deleted] = await db
      .delete(vehiclesTable)
      .where(eq(vehiclesTable.registrationNumber, registrationNumber))
      .returning({ registrationNumber: vehiclesTable.registrationNumber });

    if (!deleted) {
      res.status(404).json({ error: "Vehicle not found." });
      return;
    }
    res.status(204).send();
  },
);

router.get("/inventory/summary", async (_req, res): Promise<void> => {
  const [
    [totalRow],
    [onSiteRow],
    [offSiteRow],
    [keysInVaultRow],
    [keysNotInVaultRow],
    [keysUnknownRow],
    recentActivity,
  ] = await Promise.all([
    db.select({ value: count() }).from(vehiclesTable),
    db
      .select({ value: count() })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.onSite, true)),
    db
      .select({ value: count() })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.onSite, false)),
    db
      .select({ value: count() })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.keysStatus, "in_vault")),
    db
      .select({ value: count() })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.keysStatus, "not_in_vault")),
    db
      .select({ value: count() })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.keysStatus, "unknown")),
    db
      .select({
        registrationNumber: vehiclesTable.registrationNumber,
        onSite: vehiclesTable.onSite,
        keysStatus: vehiclesTable.keysStatus,
        updatedAt: vehiclesTable.updatedAt,
      })
      .from(vehiclesTable)
      .orderBy(desc(vehiclesTable.updatedAt))
      .limit(5),
  ]);

  res.json(
    GetInventorySummaryResponse.parse({
      total: totalRow.value,
      onSite: onSiteRow.value,
      offSite: offSiteRow.value,
      keysInVault: keysInVaultRow.value,
      keysNotInVault: keysNotInVaultRow.value,
      keysUnknown: keysUnknownRow.value,
      recentActivity,
    }),
  );
});

export default router;
