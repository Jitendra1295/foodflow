import { useEffect, useState } from 'react';
import { api, formatMoney } from '../api.js';

export default function AdminPage() {
  const [summary, setSummary] = useState(null);
  const [orders, setOrders] = useState({ orders: [], total: 0 });
  const [runs, setRuns] = useState([]);
  const [failures, setFailures] = useState([]);
  const [status, setStatus] = useState('');
  const [runId, setRunId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const query = new URLSearchParams({ status, runId, search, page });
        const results = await Promise.all([
          api('auth', '/api/admin/summary'), api('auth', `/api/admin/orders?${query}`),
          api('auth', '/api/admin/runs'), api('auth', '/api/admin/failures')
        ]);
        if (active) { setSummary(results[0]); setOrders(results[1]); setRuns(results[2]); setFailures(results[3]); setError(''); }
      } catch (err) { if (active) setError(err.message); }
    }
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [status, runId, search, page]);

  async function showInvoice(id) {
    try { setInvoice(await api('auth', `/api/admin/orders/${id}/invoice`)); }
    catch (err) { setError(err.message); }
  }
  async function downloadCases(id) {
    try {
      const cases = await api('auth', `/api/admin/runs/${id}/cases`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(cases, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `foodflow-${id}.json`; link.click();
      URL.revokeObjectURL(url);
    } catch (err) { setError(err.message); }
  }

  return <div className="admin-page">
    <h1>Super admin</h1>
    <p>All orders, invoices, delivery progress and recorded failures. Updates every five seconds.</p>
    {error && <p role="alert">{error}</p>}
    {summary && <div className="admin-stats">
      {Object.entries({ 'Total orders': summary.total, Delivered: summary.delivered, 'Restaurant rejected': summary.rejected,
        'In progress': summary.in_progress, 'Delivered order value': formatMoney(Number(summary.delivered_value_cents)) })
        .map(([label, value]) => <div className="admin-stat" key={label}><small>{label}</small><strong>{value}</strong></div>)}
    </div>}
    <h2>Load test runs</h2>
    <p>Test accounts are seeded locally; order processing uses real APIs and Kafka. A test failure records the stage and observed error, without assuming a person caused it.</p>
    <div className="admin-table-wrap"><table><thead><tr><th>Started</th><th>Requested / concurrency</th><th>Delivered</th><th>Failed</th><th>Status</th><th>Details</th></tr></thead><tbody>
      {runs.map(run => <tr key={run.id}><td>{new Date(run.started_at).toLocaleString()}</td><td>{run.requested} / {run.concurrency}</td><td>{run.delivered}</td><td>{run.failed}</td><td>{run.status}</td><td><button onClick={() => { setRunId(run.id); setPage(1); }}>View orders</button> <button onClick={() => downloadCases(run.id)}>Download results</button></td></tr>)}
      {!runs.length && <tr><td colSpan="6">No load tests yet.</td></tr>}
    </tbody></table></div>
    <h2>Orders and invoices</h2>
    <div className="admin-filters">
      <label>Search<input value={search} placeholder="Order ID, customer email or restaurant" onChange={e => { setSearch(e.target.value); setPage(1); }} /></label>
      <label>Status<select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{['pending','accepted','preparing','ready_for_pickup','picked_up','delivered','rejected'].map(s => <option key={s}>{s}</option>)}</select></label>
      <label>Run<select value={runId} onChange={e => { setRunId(e.target.value); setPage(1); }}><option value="">All orders</option>{runs.map(r => <option value={r.id} key={r.id}>{r.id}</option>)}</select></label>
    </div>
    <p>{orders.total} matching orders</p>
    <div className="admin-table-wrap"><table><thead><tr><th>Order / customer</th><th>Restaurant</th><th>Status / current stage</th><th>Delivery partner</th><th>Reason / test result</th><th>Total</th><th>Invoice</th></tr></thead><tbody>
      {orders.orders.map(o => <tr key={o.id}><td><small>{o.id}</small><br />{o.customer_email || o.customer_id}</td><td>{o.restaurant_name}</td><td>{o.status}<br /><small>{o.current_stage}</small></td><td>{o.delivery_partner || 'Unassigned'}<br /><small>{o.delivery_status}</small></td><td>{o.rejection_reason || o.delivery_issue || o.test_reason || o.kafka_error || '—'}<br /><small>{o.test_outcome}</small></td><td>{formatMoney(o.total_cents)}</td><td><button onClick={() => showInvoice(o.id)}>Invoice</button></td></tr>)}
    </tbody></table></div>
    <div className="admin-filters"><button disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page}</span><button disabled={page * 50 >= orders.total} onClick={() => setPage(page + 1)}>Next</button></div>
    <p>In-progress orders are awaiting the displayed stage; they are not automatically classified as failed. Request errors below may be retried successfully.</p>
    {invoice && <section className="admin-invoice" aria-label="Order invoice">
      <button onClick={() => setInvoice(null)}>Close invoice</button> <button onClick={() => window.print()}>Print / save PDF</button>
      <h2>Order invoice</h2><p>{invoice.invoiceNumber}</p>
      <p>{invoice.order.restaurant_name} · {invoice.order.customer_email} · {invoice.order.status}</p>
      <p>{new Date(invoice.order.created_at).toLocaleString()} · {invoice.currency}</p>
      <table><thead><tr><th>Item</th><th>Quantity</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>{invoice.items.map((item, i) => <tr key={i}><td>{item.item_name}</td><td>{item.quantity}</td><td>{formatMoney(item.unit_price_cents)}</td><td>{formatMoney(item.line_total_cents)}</td></tr>)}</tbody></table>
      <strong>Total: {formatMoney(invoice.totalCents)}</strong><p>{invoice.note}</p>
      <p>Rejection / test reason: {invoice.order.rejection_reason || invoice.order.test_reason || 'None recorded'}</p>
      {invoice.failures.map(f => <p key={f.id}>{f.service} · HTTP {f.status_code} · {f.reason}</p>)}
      {invoice.deliveryIssues.map(i => <p key={i.id}>Delivery issue: {i.reason} · {i.resolved_at ? 'Resolved' : 'Open'}</p>)}
    </section>}
    <h2>Recent request failures</h2>
    <p>Latest 100 authenticated failed actions, grouped by the service receiving the request. This records the observed error, not a root-cause verdict.</p>
    <div className="admin-table-wrap"><table><thead><tr><th>Time</th><th>Service / role</th><th>Action</th><th>Error</th></tr></thead><tbody>{failures.map(f => <tr key={f.id}><td>{new Date(f.created_at).toLocaleString()}</td><td>{f.service}<br />{f.actor_role}</td><td>{f.method} {f.path}</td><td>HTTP {f.status_code}: {f.reason}</td></tr>)}</tbody></table></div>
  </div>;
}
