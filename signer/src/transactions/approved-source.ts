import pg from 'pg'

/**
 * What the signer reads about a transaction from the APPLICATION database, with its own
 * read-only login `da_signer_ro` (ADR-023). The backend cannot hand the signer a payload:
 * the signer looks up what was approved itself.
 */
export interface ApprovedTransactionRecord {
  id: string
  status: string
  nonce: number | null
  unsignedPayload: unknown
  unsignedHash: string | null
  createdBy: string
  /** Source address (EIP-55) and chain of its network. */
  address: string
  chainId: number | null
  /** Decided approvals, newest first. */
  decisions: Array<{
    decision: 'APPROVED' | 'REJECTED'
    decidedBy: string | null
    expiresAt: Date | null
    approverActive: boolean
    approverIsReviewer: boolean
  }>
}

export interface ApprovedTransactionSource {
  load(transactionId: string): Promise<ApprovedTransactionRecord | null>
  close(): Promise<void>
}

export function createPgApprovedTransactionSource(
  connectionString: string,
): ApprovedTransactionSource {
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    // Belt and braces: the role only has SELECT, and every session is read-only too.
    options: '-c default_transaction_read_only=on',
  })

  return {
    async load(transactionId) {
      const tx = await pool.query<{
        id: string
        status: string
        nonce: number | null
        unsigned_payload: unknown
        unsigned_hash: string | null
        created_by: string
        address: string
        chain_id: number | null
      }>(
        `SELECT t.id, t.status::text AS status, t.nonce, t.unsigned_payload, t.unsigned_hash,
                t.created_by, a.address, n.chain_id
           FROM transactions t
           JOIN addresses a ON a.id = t.address_id
           JOIN networks n ON n.id = t.network_id
          WHERE t.id = $1`,
        [transactionId],
      )
      const row = tx.rows[0]
      if (!row) return null
      const decisions = await pool.query<{
        decision: 'APPROVED' | 'REJECTED'
        decided_by: string | null
        expires_at: Date | null
        approver_active: boolean
        approver_is_reviewer: boolean
      }>(
        `SELECT ap.decision::text AS decision, ap.decided_by, ap.expires_at,
                coalesce(u.status::text = 'ACTIVE', false) AS approver_active,
                EXISTS (SELECT 1 FROM user_roles r
                         WHERE r.user_id = ap.decided_by AND r.role::text = 'REVIEWER') AS approver_is_reviewer
           FROM approvals ap
           LEFT JOIN users u ON u.id = ap.decided_by
          WHERE ap.transaction_id = $1 AND ap.subject_type::text = 'TRANSACTION'
            AND ap.decision IS NOT NULL
          ORDER BY ap.decided_at DESC NULLS LAST, ap.created_at DESC`,
        [transactionId],
      )
      return {
        id: row.id,
        status: row.status,
        nonce: row.nonce,
        unsignedPayload: row.unsigned_payload,
        unsignedHash: row.unsigned_hash,
        createdBy: row.created_by,
        address: row.address,
        chainId: row.chain_id === null ? null : Number(row.chain_id),
        decisions: decisions.rows.map((d) => ({
          decision: d.decision,
          decidedBy: d.decided_by,
          expiresAt: d.expires_at,
          approverActive: d.approver_active,
          approverIsReviewer: d.approver_is_reviewer,
        })),
      }
    },
    close: () => pool.end(),
  }
}
