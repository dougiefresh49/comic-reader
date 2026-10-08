export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      aliases: {
        Row: {
          alias: string;
          alias_norm: string | null;
          character_id: string;
          created_at: string | null;
          id: number;
          scope: Database["public"]["Enums"]["alias_scope"];
          scope_id: string | null;
        };
        Insert: {
          alias: string;
          alias_norm?: string | null;
          character_id: string;
          created_at?: string | null;
          id?: number;
          scope?: Database["public"]["Enums"]["alias_scope"];
          scope_id?: string | null;
        };
        Update: {
          alias?: string;
          alias_norm?: string | null;
          character_id?: string;
          created_at?: string | null;
          id?: number;
          scope?: Database["public"]["Enums"]["alias_scope"];
          scope_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "aliases_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
        ];
      };
      appearances: {
        Row: {
          character_id: string;
          id: string;
          notes: string | null;
          search_terms: string[] | null;
          voice_actor: string | null;
          work_id: string;
        };
        Insert: {
          character_id: string;
          id?: string;
          notes?: string | null;
          search_terms?: string[] | null;
          voice_actor?: string | null;
          work_id: string;
        };
        Update: {
          character_id?: string;
          id?: string;
          notes?: string | null;
          search_terms?: string[] | null;
          voice_actor?: string | null;
          work_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "appearances_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appearances_work_id_fkey";
            columns: ["work_id"];
            isOneToOne: false;
            referencedRelation: "works";
            referencedColumns: ["id"];
          },
        ];
      };
      audio_timestamps: {
        Row: {
          alignment: Json | null;
          book_id: string;
          bubble_id: string;
          created_at: string | null;
          issue_id: string;
          normalized_alignment: Json | null;
        };
        Insert: {
          alignment?: Json | null;
          book_id: string;
          bubble_id: string;
          created_at?: string | null;
          issue_id: string;
          normalized_alignment?: Json | null;
        };
        Update: {
          alignment?: Json | null;
          book_id?: string;
          bubble_id?: string;
          created_at?: string | null;
          issue_id?: string;
          normalized_alignment?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "audio_timestamps_bubble_id_fkey";
            columns: ["bubble_id"];
            isOneToOne: true;
            referencedRelation: "bubbles";
            referencedColumns: ["id"];
          },
        ];
      };
      book_franchises: {
        Row: {
          book_id: string;
          franchise_id: string;
          position: number;
        };
        Insert: {
          book_id: string;
          franchise_id: string;
          position: number;
        };
        Update: {
          book_id?: string;
          franchise_id?: string;
          position?: number;
        };
        Relationships: [
          {
            foreignKeyName: "book_franchises_book_id_fkey";
            columns: ["book_id"];
            isOneToOne: false;
            referencedRelation: "books";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "book_franchises_franchise_id_fkey";
            columns: ["franchise_id"];
            isOneToOne: false;
            referencedRelation: "franchises";
            referencedColumns: ["id"];
          },
        ];
      };
      books: {
        Row: {
          created_at: string | null;
          id: string;
          name: string;
          published: boolean;
          publisher: string | null;
          series_id: string | null;
          series_position: number | null;
          slug: string;
          total_issues: number | null;
          wiki_host: string | null;
          wiki_title_template: string | null;
        };
        Insert: {
          created_at?: string | null;
          id: string;
          name: string;
          published?: boolean;
          publisher?: string | null;
          series_id?: string | null;
          series_position?: number | null;
          slug: string;
          total_issues?: number | null;
          wiki_host?: string | null;
          wiki_title_template?: string | null;
        };
        Update: {
          created_at?: string | null;
          id?: string;
          name?: string;
          published?: boolean;
          publisher?: string | null;
          series_id?: string | null;
          series_position?: number | null;
          slug?: string;
          total_issues?: number | null;
          wiki_host?: string | null;
          wiki_title_template?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "books_series_id_fkey";
            columns: ["series_id"];
            isOneToOne: false;
            referencedRelation: "series";
            referencedColumns: ["id"];
          },
        ];
      };
      bubbles: {
        Row: {
          ai_reasoning: string | null;
          audio_storage_path: string | null;
          book_id: string;
          box_2d: Json | null;
          character_id: string | null;
          character_type: string | null;
          created_at: string | null;
          crop_storage_path: string | null;
          emotion: string | null;
          fill_color: string | null;
          group_id: string | null;
          id: string;
          ignored: boolean;
          issue_id: string;
          kept: boolean;
          legacy_id: string | null;
          needs_audio: boolean;
          needs_ocr: boolean;
          ocr_text: string | null;
          page_number: number;
          panel_id: string | null;
          side: string | null;
          silent: boolean;
          sort_order: number;
          speaker: string | null;
          style: Json | null;
          text_geometry: Json | null;
          text_with_cues: string | null;
          type: string;
          updated_at: string | null;
          voice_description: string | null;
        };
        Insert: {
          ai_reasoning?: string | null;
          audio_storage_path?: string | null;
          book_id: string;
          box_2d?: Json | null;
          character_id?: string | null;
          character_type?: string | null;
          created_at?: string | null;
          crop_storage_path?: string | null;
          emotion?: string | null;
          fill_color?: string | null;
          group_id?: string | null;
          id?: string;
          ignored?: boolean;
          issue_id: string;
          kept?: boolean;
          legacy_id?: string | null;
          needs_audio?: boolean;
          needs_ocr?: boolean;
          ocr_text?: string | null;
          page_number: number;
          panel_id?: string | null;
          side?: string | null;
          silent?: boolean;
          sort_order: number;
          speaker?: string | null;
          style?: Json | null;
          text_geometry?: Json | null;
          text_with_cues?: string | null;
          type?: string;
          updated_at?: string | null;
          voice_description?: string | null;
        };
        Update: {
          ai_reasoning?: string | null;
          audio_storage_path?: string | null;
          book_id?: string;
          box_2d?: Json | null;
          character_id?: string | null;
          character_type?: string | null;
          created_at?: string | null;
          crop_storage_path?: string | null;
          emotion?: string | null;
          fill_color?: string | null;
          group_id?: string | null;
          id?: string;
          ignored?: boolean;
          issue_id?: string;
          kept?: boolean;
          legacy_id?: string | null;
          needs_audio?: boolean;
          needs_ocr?: boolean;
          ocr_text?: string | null;
          page_number?: number;
          panel_id?: string | null;
          side?: string | null;
          silent?: boolean;
          sort_order?: number;
          speaker?: string | null;
          style?: Json | null;
          text_geometry?: Json | null;
          text_with_cues?: string | null;
          type?: string;
          updated_at?: string | null;
          voice_description?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "bubbles_book_id_issue_id_fkey";
            columns: ["book_id", "issue_id"];
            isOneToOne: false;
            referencedRelation: "issues";
            referencedColumns: ["book_id", "id"];
          },
          {
            foreignKeyName: "bubbles_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bubbles_panel_id_fkey";
            columns: ["panel_id"];
            isOneToOne: false;
            referencedRelation: "panels";
            referencedColumns: ["id"];
          },
        ];
      };
      casting_tasks: {
        Row: {
          action: string | null;
          book_id: string;
          character_id: string;
          completed_at: string | null;
          created_at: string | null;
          id: string;
          issue_id: string;
          operation: Json | null;
          operation_at: string | null;
          status: string;
          target_voice_uuid: string | null;
        };
        Insert: {
          action?: string | null;
          book_id: string;
          character_id: string;
          completed_at?: string | null;
          created_at?: string | null;
          id?: string;
          issue_id: string;
          operation?: Json | null;
          operation_at?: string | null;
          status?: string;
          target_voice_uuid?: string | null;
        };
        Update: {
          action?: string | null;
          book_id?: string;
          character_id?: string;
          completed_at?: string | null;
          created_at?: string | null;
          id?: string;
          issue_id?: string;
          operation?: Json | null;
          operation_at?: string | null;
          status?: string;
          target_voice_uuid?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "casting_tasks_book_id_issue_id_fkey";
            columns: ["book_id", "issue_id"];
            isOneToOne: false;
            referencedRelation: "issues";
            referencedColumns: ["book_id", "id"];
          },
          {
            foreignKeyName: "casting_tasks_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "casting_tasks_target_voice_uuid_fkey";
            columns: ["target_voice_uuid"];
            isOneToOne: false;
            referencedRelation: "voices";
            referencedColumns: ["id"];
          },
        ];
      };
      castlist: {
        Row: {
          book_id: string;
          character_id: string;
          in_issue: boolean;
          issue_id: string;
          no_audio: boolean;
          voice_uuid: string | null;
        };
        Insert: {
          book_id: string;
          character_id: string;
          in_issue?: boolean;
          issue_id: string;
          no_audio?: boolean;
          voice_uuid?: string | null;
        };
        Update: {
          book_id?: string;
          character_id?: string;
          in_issue?: boolean;
          issue_id?: string;
          no_audio?: boolean;
          voice_uuid?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "castlist_book_id_issue_id_fkey";
            columns: ["book_id", "issue_id"];
            isOneToOne: false;
            referencedRelation: "issues";
            referencedColumns: ["book_id", "id"];
          },
          {
            foreignKeyName: "castlist_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "castlist_voice_uuid_fkey";
            columns: ["voice_uuid"];
            isOneToOne: false;
            referencedRelation: "voices";
            referencedColumns: ["id"];
          },
        ];
      };
      character_face_exemplars: {
        Row: {
          book_id: string;
          character_id: string | null;
          confidence: number;
          created_at: string | null;
          crop_path: string;
          detection_id: string | null;
          embedding: string | null;
          id: string;
          is_confirmed: boolean | null;
          page_number: number;
          source_issue: string;
          suggested_name: string | null;
        };
        Insert: {
          book_id: string;
          character_id?: string | null;
          confidence?: number;
          created_at?: string | null;
          crop_path: string;
          detection_id?: string | null;
          embedding?: string | null;
          id?: string;
          is_confirmed?: boolean | null;
          page_number: number;
          source_issue: string;
          suggested_name?: string | null;
        };
        Update: {
          book_id?: string;
          character_id?: string | null;
          confidence?: number;
          created_at?: string | null;
          crop_path?: string;
          detection_id?: string | null;
          embedding?: string | null;
          id?: string;
          is_confirmed?: boolean | null;
          page_number?: number;
          source_issue?: string;
          suggested_name?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "character_face_exemplars_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "character_face_exemplars_detection_id_fkey";
            columns: ["detection_id"];
            isOneToOne: false;
            referencedRelation: "panel_character_detections";
            referencedColumns: ["id"];
          },
        ];
      };
      characters: {
        Row: {
          created_at: string | null;
          display_name: string | null;
          form_of: string | null;
          franchise_id: string | null;
          full_name: string | null;
          id: string;
          updated_at: string | null;
          voice_mode: string | null;
        };
        Insert: {
          created_at?: string | null;
          display_name?: string | null;
          form_of?: string | null;
          franchise_id?: string | null;
          full_name?: string | null;
          id: string;
          updated_at?: string | null;
          voice_mode?: string | null;
        };
        Update: {
          created_at?: string | null;
          display_name?: string | null;
          form_of?: string | null;
          franchise_id?: string | null;
          full_name?: string | null;
          id?: string;
          updated_at?: string | null;
          voice_mode?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "characters_form_of_fkey";
            columns: ["form_of"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "characters_franchise_id_fkey";
            columns: ["franchise_id"];
            isOneToOne: false;
            referencedRelation: "franchises";
            referencedColumns: ["id"];
          },
        ];
      };
      franchises: {
        Row: {
          id: string;
          name: string;
        };
        Insert: {
          id: string;
          name: string;
        };
        Update: {
          id?: string;
          name?: string;
        };
        Relationships: [];
      };
      issues: {
        Row: {
          audio_count: number;
          book_id: string;
          bubble_count: number;
          created_at: string | null;
          has_audio: boolean;
          has_timestamps: boolean;
          has_webp: boolean;
          id: string;
          name: string;
          number: number;
          page_count: number;
          pipeline_paused: boolean;
          pipeline_paused_at: string | null;
          pipeline_paused_url: string | null;
          pipeline_step: string | null;
          source_pages_path: string | null;
          source_url: string | null;
          status: string;
          wiki_appearances: Json | null;
          wiki_summary: string | null;
          wiki_url: string | null;
        };
        Insert: {
          audio_count?: number;
          book_id: string;
          bubble_count?: number;
          created_at?: string | null;
          has_audio?: boolean;
          has_timestamps?: boolean;
          has_webp?: boolean;
          id: string;
          name: string;
          number: number;
          page_count?: number;
          pipeline_paused?: boolean;
          pipeline_paused_at?: string | null;
          pipeline_paused_url?: string | null;
          pipeline_step?: string | null;
          source_pages_path?: string | null;
          source_url?: string | null;
          status?: string;
          wiki_appearances?: Json | null;
          wiki_summary?: string | null;
          wiki_url?: string | null;
        };
        Update: {
          audio_count?: number;
          book_id?: string;
          bubble_count?: number;
          created_at?: string | null;
          has_audio?: boolean;
          has_timestamps?: boolean;
          has_webp?: boolean;
          id?: string;
          name?: string;
          number?: number;
          page_count?: number;
          pipeline_paused?: boolean;
          pipeline_paused_at?: string | null;
          pipeline_paused_url?: string | null;
          pipeline_step?: string | null;
          source_pages_path?: string | null;
          source_url?: string | null;
          status?: string;
          wiki_appearances?: Json | null;
          wiki_summary?: string | null;
          wiki_url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "issues_book_id_fkey";
            columns: ["book_id"];
            isOneToOne: false;
            referencedRelation: "books";
            referencedColumns: ["id"];
          },
        ];
      };
      llm_calls: {
        Row: {
          book_id: string | null;
          characters: number | null;
          created_at: string | null;
          credits: number | null;
          duration_ms: number | null;
          error: string | null;
          id: string;
          issue_id: string | null;
          model: string | null;
          ok: boolean | null;
          page_number: number | null;
          provider: string | null;
          service_tier: string | null;
          step: string | null;
          tokens_in: number | null;
          tokens_out: number | null;
          tokens_thinking: number | null;
          usd_est: number | null;
        };
        Insert: {
          book_id?: string | null;
          characters?: number | null;
          created_at?: string | null;
          credits?: number | null;
          duration_ms?: number | null;
          error?: string | null;
          id?: string;
          issue_id?: string | null;
          model?: string | null;
          ok?: boolean | null;
          page_number?: number | null;
          provider?: string | null;
          service_tier?: string | null;
          step?: string | null;
          tokens_in?: number | null;
          tokens_out?: number | null;
          tokens_thinking?: number | null;
          usd_est?: number | null;
        };
        Update: {
          book_id?: string | null;
          characters?: number | null;
          created_at?: string | null;
          credits?: number | null;
          duration_ms?: number | null;
          error?: string | null;
          id?: string;
          issue_id?: string | null;
          model?: string | null;
          ok?: boolean | null;
          page_number?: number | null;
          provider?: string | null;
          service_tier?: string | null;
          step?: string | null;
          tokens_in?: number | null;
          tokens_out?: number | null;
          tokens_thinking?: number | null;
          usd_est?: number | null;
        };
        Relationships: [];
      };
      music_scenes: {
        Row: {
          book_id: string;
          created_at: string | null;
          end_panel_id: string | null;
          id: string;
          issue_id: string;
          label: string | null;
          music_mood: string;
          start_panel_id: string | null;
        };
        Insert: {
          book_id: string;
          created_at?: string | null;
          end_panel_id?: string | null;
          id?: string;
          issue_id: string;
          label?: string | null;
          music_mood: string;
          start_panel_id?: string | null;
        };
        Update: {
          book_id?: string;
          created_at?: string | null;
          end_panel_id?: string | null;
          id?: string;
          issue_id?: string;
          label?: string | null;
          music_mood?: string;
          start_panel_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "music_scenes_end_panel_id_fkey";
            columns: ["end_panel_id"];
            isOneToOne: false;
            referencedRelation: "panels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "music_scenes_start_panel_id_fkey";
            columns: ["start_panel_id"];
            isOneToOne: true;
            referencedRelation: "panels";
            referencedColumns: ["id"];
          },
        ];
      };
      page_context: {
        Row: {
          book_id: string;
          created_at: string | null;
          gemini_model: string | null;
          issue_id: string;
          page_number: number;
          raw_response: Json | null;
          updated_at: string | null;
        };
        Insert: {
          book_id: string;
          created_at?: string | null;
          gemini_model?: string | null;
          issue_id: string;
          page_number: number;
          raw_response?: Json | null;
          updated_at?: string | null;
        };
        Update: {
          book_id?: string;
          created_at?: string | null;
          gemini_model?: string | null;
          issue_id?: string;
          page_number?: number;
          raw_response?: Json | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "page_context_book_id_issue_id_fkey";
            columns: ["book_id", "issue_id"];
            isOneToOne: false;
            referencedRelation: "issues";
            referencedColumns: ["book_id", "id"];
          },
        ];
      };
      page_segmentation: {
        Row: {
          book_id: string;
          created_at: string | null;
          id: string;
          image_height: number;
          image_width: number;
          issue_id: string;
          page_number: number;
          predictions: Json;
        };
        Insert: {
          book_id: string;
          created_at?: string | null;
          id?: string;
          image_height: number;
          image_width: number;
          issue_id: string;
          page_number: number;
          predictions?: Json;
        };
        Update: {
          book_id?: string;
          created_at?: string | null;
          id?: string;
          image_height?: number;
          image_width?: number;
          issue_id?: string;
          page_number?: number;
          predictions?: Json;
        };
        Relationships: [];
      };
      pages: {
        Row: {
          book_id: string;
          height: number;
          id: number;
          issue_id: string;
          number: number;
          reviewed_at: string | null;
          spread_with_next: boolean;
          storage_path: string | null;
          width: number;
        };
        Insert: {
          book_id: string;
          height: number;
          id?: number;
          issue_id: string;
          number: number;
          reviewed_at?: string | null;
          spread_with_next?: boolean;
          storage_path?: string | null;
          width: number;
        };
        Update: {
          book_id?: string;
          height?: number;
          id?: number;
          issue_id?: string;
          number?: number;
          reviewed_at?: string | null;
          spread_with_next?: boolean;
          storage_path?: string | null;
          width?: number;
        };
        Relationships: [
          {
            foreignKeyName: "pages_book_id_issue_id_fkey";
            columns: ["book_id", "issue_id"];
            isOneToOne: false;
            referencedRelation: "issues";
            referencedColumns: ["book_id", "id"];
          },
        ];
      };
      panel_character_detections: {
        Row: {
          character_id: string | null;
          cluster_id: number | null;
          created_at: string;
          face_bbox: Json;
          human_verified: boolean;
          id: string;
          identification_confidence: number;
          panel_id: string;
          suggested_name: string | null;
        };
        Insert: {
          character_id?: string | null;
          cluster_id?: number | null;
          created_at?: string;
          face_bbox: Json;
          human_verified?: boolean;
          id?: string;
          identification_confidence?: number;
          panel_id: string;
          suggested_name?: string | null;
        };
        Update: {
          character_id?: string | null;
          cluster_id?: number | null;
          created_at?: string;
          face_bbox?: Json;
          human_verified?: boolean;
          id?: string;
          identification_confidence?: number;
          panel_id?: string;
          suggested_name?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "panel_character_detections_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "panel_character_detections_panel_id_fkey";
            columns: ["panel_id"];
            isOneToOne: false;
            referencedRelation: "panels";
            referencedColumns: ["id"];
          },
        ];
      };
      panels: {
        Row: {
          audio_tags: Json;
          book_id: string;
          bounding_box: Json;
          cinematic_description: string | null;
          created_at: string;
          effect_positions: Json | null;
          effect_tags: string[];
          estimated_duration_seconds: number | null;
          foreground_polygons: Json | null;
          id: string;
          is_new_scene: boolean;
          issue_id: string;
          page_number: number;
          panel_id: string;
          primary_character_id: string | null;
          primary_speaker: string | null;
          scene_id: string | null;
          sort_order: number;
          source: string;
          updated_at: string;
        };
        Insert: {
          audio_tags?: Json;
          book_id: string;
          bounding_box: Json;
          cinematic_description?: string | null;
          created_at?: string;
          effect_positions?: Json | null;
          effect_tags?: string[];
          estimated_duration_seconds?: number | null;
          foreground_polygons?: Json | null;
          id?: string;
          is_new_scene?: boolean;
          issue_id: string;
          page_number: number;
          panel_id: string;
          primary_character_id?: string | null;
          primary_speaker?: string | null;
          scene_id?: string | null;
          sort_order: number;
          source?: string;
          updated_at?: string;
        };
        Update: {
          audio_tags?: Json;
          book_id?: string;
          bounding_box?: Json;
          cinematic_description?: string | null;
          created_at?: string;
          effect_positions?: Json | null;
          effect_tags?: string[];
          estimated_duration_seconds?: number | null;
          foreground_polygons?: Json | null;
          id?: string;
          is_new_scene?: boolean;
          issue_id?: string;
          page_number?: number;
          panel_id?: string;
          primary_character_id?: string | null;
          primary_speaker?: string | null;
          scene_id?: string | null;
          sort_order?: number;
          source?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "panels_book_issue_fkey";
            columns: ["book_id", "issue_id"];
            isOneToOne: false;
            referencedRelation: "issues";
            referencedColumns: ["book_id", "id"];
          },
          {
            foreignKeyName: "panels_primary_character_id_fkey";
            columns: ["primary_character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "panels_scene_id_fkey";
            columns: ["scene_id"];
            isOneToOne: false;
            referencedRelation: "music_scenes";
            referencedColumns: ["id"];
          },
        ];
      };
      pipeline_runs: {
        Row: {
          book_id: string;
          completed_at: string | null;
          id: string;
          issue_id: string;
          started_at: string | null;
          status: string;
          steps: Json | null;
        };
        Insert: {
          book_id: string;
          completed_at?: string | null;
          id?: string;
          issue_id: string;
          started_at?: string | null;
          status?: string;
          steps?: Json | null;
        };
        Update: {
          book_id?: string;
          completed_at?: string | null;
          id?: string;
          issue_id?: string;
          started_at?: string | null;
          status?: string;
          steps?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "pipeline_runs_book_id_issue_id_fkey";
            columns: ["book_id", "issue_id"];
            isOneToOne: false;
            referencedRelation: "issues";
            referencedColumns: ["book_id", "id"];
          },
        ];
      };
      series: {
        Row: {
          created_at: string;
          id: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          id: string;
          name: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
        };
        Relationships: [];
      };
      voice_archives: {
        Row: {
          archived_at: string;
          archived_for_book_id: string | null;
          former_elevenlabs_id: string;
          id: string;
          voice_id: string;
        };
        Insert: {
          archived_at?: string;
          archived_for_book_id?: string | null;
          former_elevenlabs_id: string;
          id?: string;
          voice_id: string;
        };
        Update: {
          archived_at?: string;
          archived_for_book_id?: string | null;
          former_elevenlabs_id?: string;
          id?: string;
          voice_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "voice_archives_voice_id_fkey";
            columns: ["voice_id"];
            isOneToOne: false;
            referencedRelation: "voices";
            referencedColumns: ["id"];
          },
        ];
      };
      voice_lookups: {
        Row: {
          character_id: string;
          created_at: string;
          description: string;
          inferred_from: string | null;
          labels: Json;
          model: string;
          work_id: string;
        };
        Insert: {
          character_id: string;
          created_at?: string;
          description: string;
          inferred_from?: string | null;
          labels: Json;
          model: string;
          work_id: string;
        };
        Update: {
          character_id?: string;
          created_at?: string;
          description?: string;
          inferred_from?: string | null;
          labels?: Json;
          model?: string;
          work_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "voice_lookups_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "voice_lookups_work_id_fkey";
            columns: ["work_id"];
            isOneToOne: false;
            referencedRelation: "works";
            referencedColumns: ["id"];
          },
        ];
      };
      voices: {
        Row: {
          appearance_id: string | null;
          archived_at: string | null;
          character_id: string | null;
          consumers: string[];
          created_at: string;
          current_elevenlabs_id: string | null;
          description: string | null;
          design_prompt: string | null;
          display_name: string;
          id: string;
          keep_active: boolean;
          labels: Json | null;
          operation_claim: string | null;
          operation_claimed_at: string | null;
          source_clip_md5: string | null;
          source_clip_path: string | null;
          starting_pick: boolean | null;
          status: string;
          voice_settings: Json | null;
        };
        Insert: {
          appearance_id?: string | null;
          archived_at?: string | null;
          character_id?: string | null;
          consumers?: string[];
          created_at?: string;
          current_elevenlabs_id?: string | null;
          description?: string | null;
          design_prompt?: string | null;
          display_name: string;
          id?: string;
          keep_active?: boolean;
          labels?: Json | null;
          operation_claim?: string | null;
          operation_claimed_at?: string | null;
          source_clip_md5?: string | null;
          source_clip_path?: string | null;
          starting_pick?: boolean | null;
          status: string;
          voice_settings?: Json | null;
        };
        Update: {
          appearance_id?: string | null;
          archived_at?: string | null;
          character_id?: string | null;
          consumers?: string[];
          created_at?: string;
          current_elevenlabs_id?: string | null;
          description?: string | null;
          design_prompt?: string | null;
          display_name?: string;
          id?: string;
          keep_active?: boolean;
          labels?: Json | null;
          operation_claim?: string | null;
          operation_claimed_at?: string | null;
          source_clip_md5?: string | null;
          source_clip_path?: string | null;
          starting_pick?: boolean | null;
          status?: string;
          voice_settings?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "voices_appearance_id_fkey";
            columns: ["appearance_id"];
            isOneToOne: true;
            referencedRelation: "appearances";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "voices_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
        ];
      };
      works: {
        Row: {
          franchise_id: string | null;
          id: string;
          medium: string;
          title: string;
          universe: string | null;
          year: number;
        };
        Insert: {
          franchise_id?: string | null;
          id: string;
          medium: string;
          title: string;
          universe?: string | null;
          year: number;
        };
        Update: {
          franchise_id?: string | null;
          id?: string;
          medium?: string;
          title?: string;
          universe?: string | null;
          year?: number;
        };
        Relationships: [
          {
            foreignKeyName: "works_franchise_id_fkey";
            columns: ["franchise_id"];
            isOneToOne: false;
            referencedRelation: "franchises";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      match_face_exemplars: {
        Args: {
          book_ids: string[];
          match_limit?: number;
          query_embedding: string;
        };
        Returns: {
          character_id: string;
          composite_score: number;
          confidence: number;
          crop_path: string;
          id: string;
          similarity: number;
        }[];
      };
      save_music_scenes: {
        Args: { p_book_id: string; p_issue_id: string; p_scenes: Json };
        Returns: number;
      };
      save_review_edits: {
        Args: { p_book_id: string; p_issue_id: string; p_ops: Json };
        Returns: number;
      };
      switch_bubble_audio_take: {
        Args: {
          p_alignment: Json;
          p_audio_storage_path: string;
          p_book_id: string;
          p_bubble_id: string;
          p_issue_id: string;
          p_normalized_alignment: Json;
        };
        Returns: string;
      };
      switch_group_audio_take: {
        Args: {
          p_alignment: Json;
          p_audio_storage_path: string;
          p_book_id: string;
          p_group_id: string;
          p_issue_id: string;
          p_lead_id: string;
          p_member_ids: string[];
          p_normalized_alignment: Json;
        };
        Returns: string;
      };
    };
    Enums: {
      alias_scope: "global" | "series" | "book";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  "public"
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      alias_scope: ["global", "series", "book"],
    },
  },
} as const;
