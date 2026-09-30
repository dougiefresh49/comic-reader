-- Credits for an ElevenLabs call, beside the character count it bills on (#251).
-- ElevenLabs bills a subscription in credits, so credits are the real spend and
-- the dollar column is an estimate from our own rates. Additive and nullable:
-- every row written before this lands, and every Gemini row, stays null.
alter table llm_calls add column credits numeric(10,3);
