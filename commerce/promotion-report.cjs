'use strict';

const rows = async (pool, sql, args = []) => (await pool.execute(sql, args))[0];
const real = "NOT (JSON_EXTRACT(o.snapshot,'$.is_demo') <=> TRUE)";

// New voucher applications do not create commerce_redemptions. Count them from
// confirmed settlement units so a reservation or a reversed unit is not a sale.
const applicationJoin = `FROM coupon_applications a
 JOIN commerce_coupons c ON c.id=a.coupon_id
 JOIN commerce_orders o ON o.id=c.order_id
 JOIN commerce_settlement_items i ON i.coupon_id=a.coupon_id AND i.redemption_id IS NULL AND i.unit_id IS NOT NULL
 JOIN commerce_settlement_units u ON u.id=i.unit_id AND u.status='CONFIRMED'
 WHERE a.status='consumed' AND o.source_account_id=? AND ${real}`;

async function summary(pool, accountId) {
  const [legacy] = await rows(pool, `SELECT COUNT(*) n,COALESCE(SUM(r.channel_minor),0) earned
    FROM commerce_redemptions r JOIN commerce_coupons c ON c.id=r.coupon_id
    JOIN commerce_orders o ON o.id=c.order_id
    WHERE o.source_account_id=? AND r.status='confirmed' AND ${real}`, [accountId]);
  const [applied] = await rows(pool, `SELECT COUNT(DISTINCT a.id) n,
    COALESCE(SUM(CASE WHEN i.line_kind='promoter' THEN i.payable_minor ELSE 0 END),0) earned
    ${applicationJoin}`, [accountId]);
  return {redemptions:Number(legacy.n)+Number(applied.n),confirmed_minor:Number(legacy.earned)+Number(applied.earned)};
}

async function productUsage(pool, accountId) {
  const legacy = await rows(pool, `SELECT o.product_kind,o.product_id,COUNT(*) n,COALESCE(SUM(r.channel_minor),0) earned
    FROM commerce_redemptions r JOIN commerce_coupons c ON c.id=r.coupon_id
    JOIN commerce_orders o ON o.id=c.order_id
    WHERE o.source_account_id=? AND r.status='confirmed' AND ${real}
    GROUP BY o.product_kind,o.product_id`, [accountId]);
  const applied = await rows(pool, `SELECT o.product_kind,o.product_id,COUNT(DISTINCT a.id) n,
    COALESCE(SUM(CASE WHEN i.line_kind='promoter' THEN i.payable_minor ELSE 0 END),0) earned
    ${applicationJoin} GROUP BY o.product_kind,o.product_id`, [accountId]);
  const map = new Map();
  for (const item of [...legacy, ...applied]) {
    const key = item.product_kind + ':' + item.product_id;
    const old = map.get(key) || {product_kind:item.product_kind,product_id:item.product_id,n:0,earned:0};
    old.n += Number(item.n) || 0; old.earned += Number(item.earned) || 0; map.set(key,old);
  }
  return [...map.values()];
}

async function applicationRecords(pool, accountId) {
  return rows(pool, `SELECT a.id,COALESCE(x.payable_minor,0) AS channel_minor,'confirmed' AS status,a.updated_at AS created_at,
    JSON_UNQUOTE(JSON_EXTRACT(c.snapshot,'$.sku.name')) AS coupon_name,0 AS is_demo,
    v.name AS merchant_name,CASE WHEN x.coupon_id IS NULL THEN 'not_applicable' WHEN x.discharged_minor>=x.payable_minor THEN 'paid' ELSE 'pending' END AS item_status,
    IF(x.reserved_minor>0,'executing',NULL) AS batch_status,
    IF(x.discharged_minor>=x.payable_minor,'paid',NULL) AS payout_status
    FROM coupon_applications a JOIN commerce_coupons c ON c.id=a.coupon_id
    JOIN commerce_orders o ON o.id=c.order_id
    LEFT JOIN jz_vendors v ON v.id=a.vendor_id
    LEFT JOIN (SELECT i.coupon_id,SUM(i.payable_minor) payable_minor,SUM(i.discharged_minor) discharged_minor,
      SUM(i.reserved_minor) reserved_minor
      FROM commerce_settlement_items i JOIN commerce_settlement_units u ON u.id=i.unit_id AND u.status='CONFIRMED'
      WHERE i.line_kind='promoter' AND i.redemption_id IS NULL GROUP BY i.coupon_id) x ON x.coupon_id=a.coupon_id
    WHERE o.source_account_id=? AND a.status='consumed' AND ${real}
    ORDER BY a.updated_at DESC LIMIT 50`, [accountId]);
}

async function applicationPayouts(pool, accountId) {
  return rows(pool, `SELECT e.request_no AS instruction_no,l.amount_minor,'paid' AS status,e.submitted_at,e.completed_at AS settled_at
    FROM commerce_execution_lines l JOIN commerce_settlement_items i ON i.id=l.item_id
    JOIN commerce_execution_orders e ON e.id=l.order_id
    WHERE i.promoter_account_id=? AND i.line_kind='promoter' AND i.coupon_id IS NOT NULL
      AND i.redemption_id IS NULL AND l.status='SUCCEEDED' AND l.effect_kind='PAYOUT'
    ORDER BY e.completed_at DESC LIMIT 20`, [accountId]);
}

module.exports = {summary,productUsage,applicationRecords,applicationPayouts};
