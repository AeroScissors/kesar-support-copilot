# Design notes

What I would build differently, and what I noticed in the assignment. The ideas in Part 1 come from measuring my own run; I have not built them. In Part 2 I ran the code where I could.

## Part 1. What I would do instead

I built what the brief asked for: an AI agent that chooses its tools. After measuring it, I would change six things.

| Instead of | I would | Why (measured on my 25 emails) |
|---|---|---|
| An agent choosing tools | Fetch the facts in code first, then one model call | In 20 of 22 replies the tool could be predicted from the intent. The choice cost an extra model call and gained almost nothing |
| A model writing every reply | Templates for order status | 8 of 25 emails. The answer is already in the order, so there is nothing to make up |
| A model writing facts | Let it write `{{refund}}` or `{{follow_up_time}}`, and let code fill them in | My E23 mistake ("24 business **days**") could not happen |
| Trusting confidence | Decide by the cost of a mistake | 24 of 25 emails scored 0.95 or more, including both wrong replies |
| Trusting the "From" address | A login link, or order ID plus phone | Anyone can fake a From address. My build has this gap too |
| Google Sheets for tickets | A database with one open ticket per order | Two emails at the same moment can make two tickets |

**The biggest change is to prevent the email.** Order status is 32% of this inbox. A tracking page or a WhatsApp update removes that work for less than any AI reply costs.

## Part 2. What I noticed in the assignment

**1. The date formula in `SETUP.md` can be a day wrong.** It uses n8n's timezone, and n8n's default is New York. I ran it in Luxon, n8n's date library:

| Case | Right answer | Formula, default timezone |
|---|---|---|
| E03, delivered 16 Nov | 4 days | 3 |
| E04, delivered 19 Nov | 1 day | 0 |
| A return on day 8, at 9:30 am | 8, refuse | **7, accept** |

*Fix:* count calendar days in India time.

**2. Two rules can work against the customer.** Photos are due within 48 hours, but a reply can take 24 *business* hours. At Mon–Sat, 10 to 7, a customer who writes like E04 (Friday, 9:41 am, no photos) may hear back on Monday at 4 pm. The 48 hours end by Saturday night. Four of the five damaged, wrong or missing item emails came without photos.
*Fix:* stop the clock at the first email.

**3. The test emails never test a return rule alone.** The two refused returns, E12 and E16, are both late *and* opened. A bot that forgets either rule still passes all 25. Also not covered: a late damage report, a customer with two orders, two order IDs in one email, a reaction to a product, and an order with status `processing`.
*Fix:* three more emails: late but sealed, in time but opened, and damaged after 48 hours.

**4. `send_test_emails.py` can stop at E09 on Windows.** When I saved its output to a file, it crashed on the Hindi subject: nine emails arrived and sixteen were never sent.
*Fix:* `sys.stdout.reconfigure(encoding="utf-8")`. The 60-second timeout is also short: on a slow model the script moves on while the first email is still running.

**5. Matching tickets by order ID alone is risky.** `SETUP.md` suggests it. A stranger who knows an order ID could add notes to that customer's ticket.
*Fix:* match only when the sender owns the order. My build does this.

**6. Small ones.**
- "Other" needs no reply, but E13 (GST invoice) is "other" and is waiting for one.
- The schema holds one order ID and three languages, although the shop ships all over India.
- KC-1046 is due on a Sunday, and KC-1048 arrived on one, but business days are Monday to Saturday.
- The FAQ does not say how to refund part of an order that had free shipping.

None of these stopped me. I liked that the data had a privacy trap, an injection and a follow-up email, because those are the real problems in this job.
