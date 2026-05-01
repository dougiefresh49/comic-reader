# **TMNT Lore Ingestion & Enrichment Architecture**

This document outlines an incremental, local-first pipeline for enriching a comic book reader app with TMNT-specific lore using the Turtlepedia Wiki, Vision LLMs, and Supabase.

## **1\. High-Level Workflow**

The goal is to move from "Raw Images" to "Context-Aware Comic Data" during the local ingestion phase.

1. **Structural Detection (Existing):** Use Roboflow to find panels and speech bubbles.
2. **Wiki Enrichment:** Query the Turtlepedia API using the comic's title/issue number.
3. **Vision Analysis:** Use a VLM (like Gemini 1.5 Flash) to identify characters in panels using the Wiki's "Appearances" list as a reference.
4. **Vectorization:** Convert wiki summaries into embeddings.
5. **Supabase Push:** Save clean metadata and vectors to pgvector.

## **2\. Wiki Data Extraction (MediaWiki API)**

Fandom sites run on MediaWiki. You can fetch specific sections (like "Summary" or "Appearances") to avoid messy HTML scraping.

### **API Endpoint Pattern**

`[https://turtlepedia.fandom.com/api.php](https://turtlepedia.fandom.com/api.php)?`  
 `action=parse&`  
 `page=Teenage_Mutant_Ninja_Turtles_(IDW)_Issue_1&`  
 `format=json&`  
 `prop=text|sections`

### **Ingestion Logic**

- **Search:** If the exact title isn't known, use action=query\&list=search first.
- **Parse Sections:** Identify the index for "Summary" and "Appearances".
- **Extract Text:** Fetch the content of those specific indexes to use as "Context" for your AI models.

## **3\. Database Schema (Supabase pgvector)**

Since you are already on Supabase, use pgvector to store the lore. This allows you to perform "Semantic Search" directly on your database.  
`-- Enable vector support`  
`create extension if not exists vector;`

`-- Store lore snippets linked to specific books`  
`create table book_lore (`  
 `id uuid primary key default gen_random_uuid(),`  
 `book_id uuid references books(id) on delete cascade,`  
 `section_name text, -- e.g., 'Summary', 'Trivia', 'Appearances'`  
 `content text,`  
 `embedding vector(768) -- Matches Gemini/Google embedding dimensions`  
`);`

`-- Store character locations for "Who is this?" features`  
`create table character_tags (`  
 `id uuid primary key default gen_random_uuid(),`  
 `book_id uuid references books(id),`  
 `page_number int,`  
 `character_name text,`  
 `bounding_box box, -- Use Postgres box type or JSONB for [x,y,w,h]`  
 `verified boolean default false`  
`);`

## **4\. Vision Enrichment Strategy**

Instead of training a custom model for every obscure TMNT character, use **Context-Guided Vision**.

### **The Process**

1. **Input:** A panel crop (from your Roboflow detection).
2. **Context:** The list of characters extracted from the Wiki "Appearances" section.
3. **Prompt:** \> "Here is a list of characters known to be in this issue: \[Leo, Mikey, Old Hob\]. Looking at this panel crop, identify which (if any) are present. If a character is present but not in the list, identify them by name if possible."
4. **Output:** A JSON object used to pre-populate your character_tags table.

## **5\. The "Ask" Feature (RAG Implementation)**

Because the data is already in Supabase, the user experience in the reader app is lightweight:

1. **User Question:** "Who created the Mousers?"
2. **Query:** \- Convert question to embedding.
   - Perform a similarity search in book_lore filtered by book_id.
3. **Response:** Pass the top snippet \+ the question to a cheap LLM (Gemini 1.5 Flash) to generate a conversational answer for the kids.

## **6\. Recommended Local Tools**

- **Embedding Model:** Xenova/all-MiniLM-L6-v2 (via Transformers.js) for free, local vector generation during ingestion.
- **Wiki Client:** nodemw (Node.js) for easier MediaWiki API interaction.
- **Vision/LLM:** Gemini 1.5 Flash API (very high rate limits and low cost for hobbyists).

## **7\. Integration with Admin Dashboard**

Since you have a manual review flow:

- **Pre-fill:** Show the AI-detected characters in the dashboard.
- **One-Click Verify:** Use your dashboard to confirm "Yes, that is Raphael" while you are already checking bubble alignment and audio quality.
- **Audio Alignment:** Use the Wiki character list to automatically assign specific TTS voices (e.g., a "brash" voice for Raph, a "calm" voice for Splinter).
