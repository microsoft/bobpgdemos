-- Step 5 of the walkthrough: a 16-part dock audit handbook (about 320 chunks).
-- Revising it updates all 16 parts in one statement, so the on_change trigger
-- starts ONE pipeline run long enough (30-60 s) to fail over in the middle of Embed.
-- Each part stays under the article content limit (20,000 characters).
INSERT INTO knowledge_hub.seed_article (title, category, content)
SELECT format('Dock audit handbook, part %s', part),
       'Facility runbook',
       string_agg(
           format('Part %s, check %s: at dock door %s, count the pallets on shelf %s-%s, confirm the stretch wrap is intact, record the seal number, and note any damage in the audit log.',
                  part, line, 1 + (part * 7 + line) % 24, part, line),
           ' ' ORDER BY line)
FROM generate_series(1, 16) AS part, generate_series(1, 110) AS line
GROUP BY part
ON CONFLICT (title) DO UPDATE
SET category = EXCLUDED.category,
    content = EXCLUDED.content;

INSERT INTO knowledge_hub.article (title, category, content)
SELECT seed.title, seed.category, seed.content
FROM knowledge_hub.seed_article seed
WHERE seed.title LIKE 'Dock audit handbook, part %'
  AND NOT EXISTS (SELECT 1 FROM knowledge_hub.article article WHERE article.title = seed.title);

-- Revise every part in one UPDATE (one statement, one pipeline run). Part 1 gets a
-- new rule that step 5 searches for afterwards. Returns part 1's article_id.
CREATE OR REPLACE FUNCTION knowledge_hub.revise_handbook()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    revised integer;
    stamp text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
    rule_article integer;
BEGIN
    UPDATE knowledge_hub.article article
    SET content = seed.content || format(' Revised %s UTC.', stamp)
                  || CASE WHEN seed.title = 'Dock audit handbook, part 1'
                          THEN ' New rule: forklifts in Dock 4 must not exceed 8 km/h, and every Dock 4 operator wears a high-visibility vest.'
                          ELSE '' END
    FROM knowledge_hub.seed_article seed
    WHERE seed.title LIKE 'Dock audit handbook, part %'
      AND article.title = seed.title;
    GET DIAGNOSTICS revised = ROW_COUNT;
    IF revised = 0 THEN
        RAISE EXCEPTION 'The dock audit handbook is missing. Run sql/06-failover-handbook.sql.';
    END IF;
    SELECT article_id INTO rule_article
    FROM knowledge_hub.article
    WHERE title = 'Dock audit handbook, part 1';
    RETURN rule_article;
END;
$$;
