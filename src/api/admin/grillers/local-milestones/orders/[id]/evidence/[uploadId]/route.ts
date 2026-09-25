import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { LocalEvidenceError, type EvidenceUpload } from "../../../../../../../../lib/local-evidence-contract"
import {
  authorizedEvidence, evidenceFailure, readEvidenceBytes,
} from "../../../../../../../../lib/local-evidence-http"

/** PUT image bytes with stable upload ID, SHA-256, size and image Content-Type. */
export async function PUT(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { storage } = await authorizedEvidence(req, req.params.id)
    const contentType = String(req.headers["content-type"] || "").toLowerCase()
    const sizeBytes = Number(req.headers["x-gp-evidence-size"])
    const input: EvidenceUpload = {
      uploadId: req.params.uploadId, orderId: req.params.id,
      contentType: contentType as EvidenceUpload["contentType"], sizeBytes,
      sha256: String(req.headers["x-gp-evidence-sha256"] || ""),
    }
    const length = req.headers["content-length"]
    if (length !== undefined && Number(length) !== sizeBytes)
      throw new LocalEvidenceError("evidence_content_mismatch")
    await storage.prepare(input)
    const bytes = await readEvidenceBytes(req, sizeBytes)
    const result = await storage.complete({ uploadId: input.uploadId, orderId: input.orderId, bytes })
    return res.status(result.duplicate ? 200 : 201).json({ evidence: result.record, duplicate: result.duplicate })
  } catch (error) {
    return evidenceFailure(res, error)
  }
}

/** A signed link is issued only after fresh named-staff and order authorization. */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { storage, actor } = await authorizedEvidence(req, req.params.id)
    const record = (await storage.listOrder(req.params.id))
      .find(item => item.uploadId === req.params.uploadId)
    if (!record) throw new LocalEvidenceError("evidence_access_denied")
    const signed = await storage.signDownload({ evidenceId: record.evidenceId, actorId: actor.id, ttlSeconds: 60 })
    res.setHeader("Cache-Control", "no-store")
    return res.json({ evidence: record, ...signed })
  } catch (error) {
    return evidenceFailure(res, error)
  }
}
