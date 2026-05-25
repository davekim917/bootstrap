Run /review-swarm on this newly added file. It is the only change in the diff.

File: `src/routes/orders.ts`

```typescript
import { Router } from 'express';
import { db } from '../db';

const router = Router();

// Returns all orders for a user, with their line items.
router.get('/orders', async (req, res) => {
  const userId = req.query.userId as string;

  // Look up the user's orders.
  const orders = await db.query(
    `SELECT * FROM orders WHERE user_id = ${userId} ORDER BY created_at DESC`,
  );

  // Attach line items to each order.
  const result = [];
  for (const order of orders.rows) {
    const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    result.push({ ...order, items: items.rows });
  }

  res.json(result);
});

export default router;
```

This endpoint is mounted at `/api` and is reachable by any authenticated session.
