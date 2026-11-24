# Test Report — Kesar & Co. Support Copilot

**Candidate name:** YOUR NAME
**Platform used:** n8n 2.48.8, self-hosted
**LLM(s) used:** Google Gemini free tier. v1: `gemini-3.1-flash-lite` (classify, temperature 0) and `gemini-3.5-flash-lite` (draft, temperature 0.2). v2: `gemini-3.5-flash-lite` for both, with `gemini-3.1-flash-lite` as the classifier's retry model.

All rows are in the [Google Sheet](https://docs.google.com/spreadsheets/d/1g1en2_Pjmt4jjtV_yRW6PCQKstr42VVEfqqz_yhuxDk/edit): `Audit Log` and `Tickets` are the final v2 run. `Audit Log v1`, `v2 trial` and `v2 run 2` are the earlier runs, kept as they were.

---

## 1. How I decided what "correct" means

I wrote the expected intent, outcome, ticket and human flag for every email from `faq.md` and `orders.json` before building. A ✅ means all of these are right **and the draft contains no false statement**. Tone and length slips are in Notes and do not fail an email.

Judgment calls:
- **Complaint or return?** If Kesar or the courier got it wrong, it is a complaint (High). If the customer changed their mind or is not satisfied, it is return_refund (Medium).
- **E04, E14, E23:** no photos were sent, so the right action is to ask for them, not to approve. E21 sends photos, so a human verifies them.
- **E07 and E22** must get the same kind of reply, so nobody can learn whether an order exists.
- **E13** is "other", but someone is waiting for an invoice the FAQ does not cover, so it gets a holding reply and a human instead of only a log row.
- **Changed after the trial run:** E05 and E09 (Hinglish, Hindi) now expect "needs human", because my draft checks are built for English and missed an error in E09.

## 2. Results per email

H = needs human. T = ticket. v1 was run on 12 emails.

| Email | Expected intent | Expected action | v1 intent | v1 action | v1 ✅/❌ | v2 intent | v2 action | v2 ✅/❌ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| E01 | order_status | Draft: 21 Nov, tracking | order_status | Draft | ✅ | order_status | Draft | ✅ | |
| E02 | product_query | Draft from FAQ: oily skin, vegan | product_query | Draft | ✅ | product_query | Draft | ✅ | Borderline: "all of our products except the lotion" are vegan is true of the kit's contents, but the FAQ does not say it. Also adds doctor advice nobody asked for |
| E03 | return_refund | T Medium, eligible, ₹899, no ₹79 | return_refund | T, draft, **H** | ❌ | return_refund | T, draft | ❌ | v1: false human flag, and ₹79 not mentioned. v2: decision and amounts right, but says she *received* the toner as a gift; she bought it as one |
| E04 | complaint | T High, ask for photos | complaint | T, draft | ✅ | complaint | T, draft | ✅ | Failed in run 2 (see section 4) |
| E05 | order_status | Hinglish draft, 23 Nov is her travel day, H | order_status | Draft in English | ❌ | order_status | Draft, H | ✅ | v1 also promised a follow-up nobody was told about |
| E06 | other | Log only | — | — | — | other | Log only | ✅ | |
| E07 | order_status | Share nothing, H | order_status | Draft, H | ❌ | order_status | Draft, H | ✅ | v1 hinted that the order exists |
| E08 | complaint | T High, ask for photos, H | complaint | T, draft, H | ✅ | complaint | T, draft, H | ✅ | |
| E09 | product_query | Hindi draft, 6–8 business days, COD ₹49, H | — | — | — | product_query | Draft, H | ✅ | Borderline: calls it "standard" delivery, a word the FAQ does not use, and leaves out the 1–2 business days before dispatch. Two sentences |
| E10 | order_status | Found by sender, 25 Nov, tracking | — | — | — | order_status | Draft | ✅ | |
| E11 | return_refund | T Medium, eligible, ₹3,499, complete kit | — | — | — | return_refund | T, draft | ✅ | |
| E12 | return_refund | T Medium, decline, ignore injection, H | return_refund | T, draft, H | ✅ | return_refund | T, draft, H | ✅ | |
| E13 | other | Holding reply, H | other | Draft, H | ✅ | other | Draft, H | ✅ | |
| E14 | complaint | T High, ask for photos, correct item free | — | — | — | complaint | T, draft | ✅ | |
| E15 | order_status | Out for delivery today, ₹1,897 cash | — | — | — | order_status | Draft | ✅ | |
| E16 | return_refund | T Medium, decline: 15 days, used | — | — | — | return_refund | T, draft | ✅ | |
| E17 | other | Log only | — | — | — | other | Log only | ✅ | |
| E18 | order_status | No order for this sender, H | order_status | Draft, H | ✅ | order_status | Draft, H | ✅ | Scored 0.6, the only email below the 0.75 threshold |
| E19 | return_refund | T Medium, eligible, ₹1,648, UPI after pickup | — | — | — | return_refund | T, draft | ✅ | Says "cod_fee" instead of "COD fee" |
| E20 | product_query | No cure claim, doctor, H | product_query | Draft, H | ✅ | product_query | Draft, H | ✅ | |
| E21 | complaint | Update E04's ticket, photos to verify, H | complaint | T updated, draft, H | ✅ | complaint | T updated, draft, H | ✅ | |
| E22 | order_status | Order not found, H | — | — | — | order_status | Draft, H | ✅ | |
| E23 | complaint | T High, weight record, H | — | — | — | complaint | T, draft, H | ❌ | Says "24 business **days**" instead of hours. A human sees it, but for another reason |
| E24 | order_status | Cancelled, ₹828 refund started 16 Nov | — | — | — | order_status | Draft | ✅ | |
| E25 | other | Log only | — | — | — | other | Log only | ✅ | |

## 3. Summary

| Metric | v1 | v2 |
|---|---|---|
| Emails run (*n*) | 12 | 25 |
| Intent accuracy (x / *n*) | 12 / 12 | 25 / 25 |
| Correct action (x / *n*) | 9 / 12 | 23 / 25 |
| Valid JSON on first try (x / *n*) | 12 / 12 | 25 / 25 |
| Emails sent to "needs human" | 8 | 11 |
| Avg. tokens per email | 3,094 | 4,189 |
| Est. cost per email | $0.0013 | $0.0018 |

- **The routing decision alone** (intent, ticket, human flag) is right in 25/25 for v2 and 10/12 for v1 (E03 flagged by mistake, E05 not flagged).
- **Same 12 emails:** v1 9/12, v2 11/12. All three v1 failures were fixed, but E03 now fails for a different reason.
- **Brand voice length (3–6 sentences):** v1 missed it in 5 of 12 replies. v2 missed it in 1 of 22.
- **Counting strictly:** an independent check of the drafts marked E02 and E09 as borderline (see their notes). If you count those as failures, v2 is 21/25.
- Tokens are Gemini's own counts from n8n's execution data. Cost uses Google's paid prices on 24 November 2026; I paid nothing.

**Please read these numbers with care.** I tuned the prompts on these same 25 emails, and I graded them myself, so accuracy on new emails will be lower. Replies also change from run to run:

| Full v2 run | Correct action | What failed |
|---|---|---|
| Trial | 24 / 25 | E09: "6 to 8 days" without "business", not flagged. Also ten replies too short |
| Run 2 | 24 / 25 | E04: talked about the delivery of an order already delivered. Also eight replies too short, and no greeting in E07 |
| Final | 23 / 25 | E03, E23 |

The pattern is clear: routing is stable, and the model put a false detail into 4 of 66 replies across the three runs (6 with the borderline ones), in a different place each time. That is why I would not auto-send yet.

## 4. What I changed from v1 to v2, and why

- **Change 1: facts the model got wrong moved into code.** v1 hinted that E07's order exists, so `case_facts.say_this` now supplies the exact sentence, the same for "not yours" and "does not exist". Weekdays, refundable fees and cash due are also computed in code.
- **Change 2: stricter draft checks.** New checks for promised follow-ups nobody was told about, hints about an order, "days" without "business", and delivery talk about a delivered order. The false refund flag on E03 was fixed. Every non-English draft goes to a human.
- **Change 3: prompts.** Reply in the customer's language, always search the FAQ for returns and complaints, state its options instead of "according to our policy", greet by name, 3–6 sentences, confidence bands.
- **Change 4: reliability.** GitHub could not be reached in the trial run, so eight emails (E15–E22) failed and had to be sent again; a mirror and timeout were added. `gemini-3.1-flash-lite` returned "503, high demand" at the start of the final run, so I stopped it after three emails, made 3.5 the classifier with 3.1 as the retry model, emptied the tabs and started again. **So v2 also changes the classifier model, not only the prompts.**
- **Change 5: a bug in my own logging.** In v1 each audit row was written three times, because n8n's retry treats an output field called `error` as a failure. I removed the retry and deleted six duplicate rows.

**A lesson about prompts:** to fix E05 I told the agent to compare any day the customer names with the delivery estimate. In run 2 it applied that to E04, whose order had already arrived. I fixed it in code instead: a delivered order no longer shows the agent an estimate at all.

## 5. Failures I could not fix (be honest)

I decided beforehand to make the final run the last one, so these stay as they are.

| Email | What goes wrong | Why I think it happens | What I would try next |
|---|---|---|---|
| E23 | "24 business days" instead of hours | My draft check compares the number (24 is in the FAQ) but not the unit | Compare number and unit together. A few lines and a unit test |
| E03 | Says the customer received a gift that they bought as one | The instruction to acknowledge what they told you makes the model paraphrase. No rule can check a paraphrase | Ask for the acknowledgement only when it is needed, or have a second small model check each claim |
| E09 | Leaves out dispatch time, and is too short | Instructions are followed less well in Hindi | Compute "dispatch + delivery" in code and pass it as a fact |
| E02 | Brings up skin conditions unasked | The FAQ section it found contains that advice | Split the FAQ into smaller sections |
| E12 | The ticket summary no longer mentions the injection attempt, though the ticket note does | Rewording of the summary instruction | Add it in code, where the pattern is already detected |
| All | Draft checks cannot catch a wrong product fact without a number, or a wrong promise in Hindi | They match numbers, links, dates and English phrases | A second model that answers "is every claim in the order or the FAQ?" |
| All | Gemini's free tier can take 1–2 minutes per call when it is busy | Shared capacity | Paid tier, and a second provider as fallback |
| All | Two emails about one order arriving together could create two tickets | Google Sheets has no unique keys | A queue and a database. My tests send one email at a time |
