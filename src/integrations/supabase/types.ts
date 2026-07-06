export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      cash_movements: {
        Row: {
          amount: number
          cash_register_id: string
          created_at: string
          created_by: string
          id: string
          reason: string | null
          store_id: string
          type: string
        }
        Insert: {
          amount: number
          cash_register_id: string
          created_at?: string
          created_by: string
          id?: string
          reason?: string | null
          store_id: string
          type: string
        }
        Update: {
          amount?: number
          cash_register_id?: string
          created_at?: string
          created_by?: string
          id?: string
          reason?: string | null
          store_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_movements_cash_register_id_fkey"
            columns: ["cash_register_id"]
            isOneToOne: false
            referencedRelation: "cash_registers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_movements_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_registers: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          closing_amount: number | null
          created_at: string
          difference: number | null
          expected_amount: number | null
          id: string
          notes: string | null
          opened_at: string
          opened_by: string
          opening_amount: number
          status: string
          store_id: string
          terminal: string
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          closing_amount?: number | null
          created_at?: string
          difference?: number | null
          expected_amount?: number | null
          id?: string
          notes?: string | null
          opened_at?: string
          opened_by: string
          opening_amount?: number
          status?: string
          store_id: string
          terminal?: string
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          closing_amount?: number | null
          created_at?: string
          difference?: number | null
          expected_amount?: number | null
          id?: string
          notes?: string | null
          opened_at?: string
          opened_by?: string
          opening_amount?: number
          status?: string
          store_id?: string
          terminal?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_registers_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address_line: string | null
          birthday: string | null
          city: string | null
          created_at: string
          credit_limit: number
          discount_percent: number
          doc: string | null
          doc_type: string | null
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          state: string | null
          store_id: string
          updated_at: string
          whatsapp: string | null
          zip: string | null
        }
        Insert: {
          address_line?: string | null
          birthday?: string | null
          city?: string | null
          created_at?: string
          credit_limit?: number
          discount_percent?: number
          doc?: string | null
          doc_type?: string | null
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          state?: string | null
          store_id: string
          updated_at?: string
          whatsapp?: string | null
          zip?: string | null
        }
        Update: {
          address_line?: string | null
          birthday?: string | null
          city?: string | null
          created_at?: string
          credit_limit?: number
          discount_percent?: number
          doc?: string | null
          doc_type?: string | null
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          state?: string | null
          store_id?: string
          updated_at?: string
          whatsapp?: string | null
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      fiscal_checklist: {
        Row: {
          done: boolean
          done_at: string | null
          id: string
          notes: string | null
          step_key: string
          store_id: string
          updated_at: string
        }
        Insert: {
          done?: boolean
          done_at?: string | null
          id?: string
          notes?: string | null
          step_key: string
          store_id: string
          updated_at?: string
        }
        Update: {
          done?: boolean
          done_at?: string | null
          id?: string
          notes?: string | null
          step_key?: string
          store_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fiscal_checklist_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      fiscal_configs: {
        Row: {
          certificate_expires_on: string | null
          certificate_filename: string | null
          certificate_password_set: boolean
          certificate_path: string | null
          certificate_subject: string | null
          certificate_uploaded: boolean
          cnae: string | null
          crt: string | null
          csc_id: string | null
          csc_token: string | null
          environment: Database["public"]["Enums"]["fiscal_env"]
          nfce_next_number: number
          nfce_series: number
          nfe_next_number: number
          nfe_series: number
          provider: Database["public"]["Enums"]["fiscal_provider"]
          provider_api_key_set: boolean
          provider_api_url: string | null
          store_id: string
          updated_at: string
        }
        Insert: {
          certificate_expires_on?: string | null
          certificate_filename?: string | null
          certificate_password_set?: boolean
          certificate_path?: string | null
          certificate_subject?: string | null
          certificate_uploaded?: boolean
          cnae?: string | null
          crt?: string | null
          csc_id?: string | null
          csc_token?: string | null
          environment?: Database["public"]["Enums"]["fiscal_env"]
          nfce_next_number?: number
          nfce_series?: number
          nfe_next_number?: number
          nfe_series?: number
          provider?: Database["public"]["Enums"]["fiscal_provider"]
          provider_api_key_set?: boolean
          provider_api_url?: string | null
          store_id: string
          updated_at?: string
        }
        Update: {
          certificate_expires_on?: string | null
          certificate_filename?: string | null
          certificate_password_set?: boolean
          certificate_path?: string | null
          certificate_subject?: string | null
          certificate_uploaded?: boolean
          cnae?: string | null
          crt?: string | null
          csc_id?: string | null
          csc_token?: string | null
          environment?: Database["public"]["Enums"]["fiscal_env"]
          nfce_next_number?: number
          nfce_series?: number
          nfe_next_number?: number
          nfe_series?: number
          provider?: Database["public"]["Enums"]["fiscal_provider"]
          provider_api_key_set?: boolean
          provider_api_url?: string | null
          store_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fiscal_configs_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: true
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          access_key: string | null
          created_at: string
          danfe_url: string | null
          environment: Database["public"]["Enums"]["fiscal_env"]
          id: string
          issued_at: string | null
          number: number
          protocol: string | null
          provider_ref: string | null
          provider_response: Json | null
          rejection_reason: string | null
          sale_id: string | null
          series: number
          status: Database["public"]["Enums"]["invoice_status"]
          store_id: string
          total: number
          type: Database["public"]["Enums"]["invoice_type"]
          updated_at: string
          xml_url: string | null
        }
        Insert: {
          access_key?: string | null
          created_at?: string
          danfe_url?: string | null
          environment?: Database["public"]["Enums"]["fiscal_env"]
          id?: string
          issued_at?: string | null
          number: number
          protocol?: string | null
          provider_ref?: string | null
          provider_response?: Json | null
          rejection_reason?: string | null
          sale_id?: string | null
          series: number
          status?: Database["public"]["Enums"]["invoice_status"]
          store_id: string
          total?: number
          type: Database["public"]["Enums"]["invoice_type"]
          updated_at?: string
          xml_url?: string | null
        }
        Update: {
          access_key?: string | null
          created_at?: string
          danfe_url?: string | null
          environment?: Database["public"]["Enums"]["fiscal_env"]
          id?: string
          issued_at?: string | null
          number?: number
          protocol?: string | null
          provider_ref?: string | null
          provider_response?: Json | null
          rejection_reason?: string | null
          sale_id?: string | null
          series?: number
          status?: Database["public"]["Enums"]["invoice_status"]
          store_id?: string
          total?: number
          type?: Database["public"]["Enums"]["invoice_type"]
          updated_at?: string
          xml_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      product_stocks: {
        Row: {
          id: string
          min_quantity: number
          product_id: string
          quantity: number
          store_id: string
          updated_at: string
        }
        Insert: {
          id?: string
          min_quantity?: number
          product_id: string
          quantity?: number
          store_id: string
          updated_at?: string
        }
        Update: {
          id?: string
          min_quantity?: number
          product_id?: string
          quantity?: number
          store_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_stocks_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_stocks_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "v_reorder"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "product_stocks_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          active: boolean
          barcode: string | null
          category: string | null
          cest: string | null
          cfop: string | null
          created_at: string
          csosn: string | null
          cst: string | null
          description: string | null
          icms_rate: number | null
          id: string
          image_url: string | null
          is_weighable: boolean
          lead_time_days: number
          max_stock: number | null
          min_stock: number
          name: string
          ncm: string | null
          origin: string | null
          price_cost: number
          price_sell: number
          reorder_qty: number | null
          sku: string | null
          store_id: string
          supplier_id: string | null
          unit: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          barcode?: string | null
          category?: string | null
          cest?: string | null
          cfop?: string | null
          created_at?: string
          csosn?: string | null
          cst?: string | null
          description?: string | null
          icms_rate?: number | null
          id?: string
          image_url?: string | null
          is_weighable?: boolean
          lead_time_days?: number
          max_stock?: number | null
          min_stock?: number
          name: string
          ncm?: string | null
          origin?: string | null
          price_cost?: number
          price_sell?: number
          reorder_qty?: number | null
          sku?: string | null
          store_id: string
          supplier_id?: string | null
          unit?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          barcode?: string | null
          category?: string | null
          cest?: string | null
          cfop?: string | null
          created_at?: string
          csosn?: string | null
          cst?: string | null
          description?: string | null
          icms_rate?: number | null
          id?: string
          image_url?: string | null
          is_weighable?: boolean
          lead_time_days?: number
          max_stock?: number | null
          min_stock?: number
          name?: string
          ncm?: string | null
          origin?: string | null
          price_cost?: number
          price_sell?: number
          reorder_qty?: number | null
          sku?: string | null
          store_id?: string
          supplier_id?: string | null
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_supplier_fk"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          default_store_id: string | null
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          default_store_id?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          default_store_id?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_default_store_id_fkey"
            columns: ["default_store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_items: {
        Row: {
          created_at: string
          id: string
          product_id: string
          purchase_id: string
          quantity: number
          store_id: string
          total: number
          unit_cost: number
        }
        Insert: {
          created_at?: string
          id?: string
          product_id: string
          purchase_id: string
          quantity: number
          store_id: string
          total?: number
          unit_cost?: number
        }
        Update: {
          created_at?: string
          id?: string
          product_id?: string
          purchase_id?: string
          quantity?: number
          store_id?: string
          total?: number
          unit_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "v_reorder"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "purchase_items_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_items_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      purchases: {
        Row: {
          created_at: string
          created_by: string
          doc_number: string | null
          doc_series: string | null
          id: string
          notes: string | null
          received_at: string | null
          status: string
          store_id: string
          supplier_id: string | null
          total: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          doc_number?: string | null
          doc_series?: string | null
          id?: string
          notes?: string | null
          received_at?: string | null
          status?: string
          store_id: string
          supplier_id?: string | null
          total?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          doc_number?: string | null
          doc_series?: string | null
          id?: string
          notes?: string | null
          received_at?: string | null
          status?: string
          store_id?: string
          supplier_id?: string | null
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchases_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchases_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      receipt_settings: {
        Row: {
          ask_customer: boolean
          created_at: string
          default_document: string
          extra_info: string | null
          font_size: string
          footer_text: string | null
          header_text: string | null
          logo_url: string | null
          paper_width: number
          print_auto: boolean
          show_address: boolean
          show_cnpj: boolean
          show_customer: boolean
          show_item_code: boolean
          show_logo: boolean
          show_operator: boolean
          show_qrcode: boolean
          store_id: string
          thank_you_text: string | null
          updated_at: string
        }
        Insert: {
          ask_customer?: boolean
          created_at?: string
          default_document?: string
          extra_info?: string | null
          font_size?: string
          footer_text?: string | null
          header_text?: string | null
          logo_url?: string | null
          paper_width?: number
          print_auto?: boolean
          show_address?: boolean
          show_cnpj?: boolean
          show_customer?: boolean
          show_item_code?: boolean
          show_logo?: boolean
          show_operator?: boolean
          show_qrcode?: boolean
          store_id: string
          thank_you_text?: string | null
          updated_at?: string
        }
        Update: {
          ask_customer?: boolean
          created_at?: string
          default_document?: string
          extra_info?: string | null
          font_size?: string
          footer_text?: string | null
          header_text?: string | null
          logo_url?: string | null
          paper_width?: number
          print_auto?: boolean
          show_address?: boolean
          show_cnpj?: boolean
          show_customer?: boolean
          show_item_code?: boolean
          show_logo?: boolean
          show_operator?: boolean
          show_qrcode?: boolean
          store_id?: string
          thank_you_text?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "receipt_settings_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: true
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      sale_items: {
        Row: {
          barcode: string | null
          created_at: string
          id: string
          product_id: string
          product_name: string
          quantity: number
          sale_id: string
          store_id: string
          total: number
          unit_price: number
        }
        Insert: {
          barcode?: string | null
          created_at?: string
          id?: string
          product_id: string
          product_name: string
          quantity: number
          sale_id: string
          store_id: string
          total: number
          unit_price: number
        }
        Update: {
          barcode?: string | null
          created_at?: string
          id?: string
          product_id?: string
          product_name?: string
          quantity?: number
          sale_id?: string
          store_id?: string
          total?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "sale_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "v_reorder"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "sale_items_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      sale_payments: {
        Row: {
          amount: number
          created_at: string
          id: string
          method: Database["public"]["Enums"]["payment_method"]
          sale_id: string
          store_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          method: Database["public"]["Enums"]["payment_method"]
          sale_id: string
          store_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          sale_id?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sale_payments_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_payments_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      sales: {
        Row: {
          cash_register_id: string | null
          change_given: number
          created_at: string
          customer_cpf: string | null
          customer_id: string | null
          customer_name: string | null
          discount: number
          document_type: string
          finalized_at: string | null
          id: string
          operator_id: string
          status: Database["public"]["Enums"]["sale_status"]
          store_id: string
          subtotal: number
          total: number
          updated_at: string
        }
        Insert: {
          cash_register_id?: string | null
          change_given?: number
          created_at?: string
          customer_cpf?: string | null
          customer_id?: string | null
          customer_name?: string | null
          discount?: number
          document_type?: string
          finalized_at?: string | null
          id?: string
          operator_id: string
          status?: Database["public"]["Enums"]["sale_status"]
          store_id: string
          subtotal?: number
          total?: number
          updated_at?: string
        }
        Update: {
          cash_register_id?: string | null
          change_given?: number
          created_at?: string
          customer_cpf?: string | null
          customer_id?: string | null
          customer_name?: string | null
          discount?: number
          document_type?: string
          finalized_at?: string | null
          id?: string
          operator_id?: string
          status?: Database["public"]["Enums"]["sale_status"]
          store_id?: string
          subtotal?: number
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sales_cash_register_fk"
            columns: ["cash_register_id"]
            isOneToOne: false
            referencedRelation: "cash_registers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_movements: {
        Row: {
          created_at: string
          created_by: string
          id: string
          product_id: string
          quantity: number
          reason: string | null
          ref_sale_id: string | null
          store_id: string
          type: Database["public"]["Enums"]["movement_type"]
          unit_cost: number | null
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          product_id: string
          quantity: number
          reason?: string | null
          ref_sale_id?: string | null
          store_id: string
          type: Database["public"]["Enums"]["movement_type"]
          unit_cost?: number | null
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          product_id?: string
          quantity?: number
          reason?: string | null
          ref_sale_id?: string | null
          store_id?: string
          type?: Database["public"]["Enums"]["movement_type"]
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "v_reorder"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "stock_movements_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      stores: {
        Row: {
          address_line: string | null
          city: string | null
          cnpj: string | null
          created_at: string
          created_by: string
          fantasy_name: string | null
          id: string
          ie: string | null
          im: string | null
          name: string
          phone: string | null
          state: string | null
          tax_regime: Database["public"]["Enums"]["tax_regime"]
          updated_at: string
          zip: string | null
        }
        Insert: {
          address_line?: string | null
          city?: string | null
          cnpj?: string | null
          created_at?: string
          created_by: string
          fantasy_name?: string | null
          id?: string
          ie?: string | null
          im?: string | null
          name: string
          phone?: string | null
          state?: string | null
          tax_regime?: Database["public"]["Enums"]["tax_regime"]
          updated_at?: string
          zip?: string | null
        }
        Update: {
          address_line?: string | null
          city?: string | null
          cnpj?: string | null
          created_at?: string
          created_by?: string
          fantasy_name?: string | null
          id?: string
          ie?: string | null
          im?: string | null
          name?: string
          phone?: string | null
          state?: string | null
          tax_regime?: Database["public"]["Enums"]["tax_regime"]
          updated_at?: string
          zip?: string | null
        }
        Relationships: []
      }
      suppliers: {
        Row: {
          address_line: string | null
          city: string | null
          cnpj: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          state: string | null
          store_id: string
          updated_at: string
        }
        Insert: {
          address_line?: string | null
          city?: string | null
          cnpj?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          state?: string | null
          store_id: string
          updated_at?: string
        }
        Update: {
          address_line?: string | null
          city?: string | null
          cnpj?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          state?: string | null
          store_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          store_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          store_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          store_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_reorder: {
        Row: {
          avg_daily_sales: number | null
          barcode: string | null
          current_stock: number | null
          days_of_stock: number | null
          lead_time_days: number | null
          max_stock: number | null
          min_stock: number | null
          name: string | null
          product_id: string | null
          reorder_qty: number | null
          sku: string | null
          sold_30d: number | null
          status: string | null
          store_id: string | null
          suggested_qty: number | null
          supplier_id: string | null
          unit: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_supplier_fk"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      can_manage_store: {
        Args: { _store_id: string; _user_id: string }
        Returns: boolean
      }
      can_operate_pdv: {
        Args: { _store_id: string; _user_id: string }
        Returns: boolean
      }
      cleanup_orphan_user_links: {
        Args: { _manager_user_id?: string }
        Returns: Json
      }
      current_open_register: { Args: { _store_id: string }; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _store_id: string
          _user_id: string
        }
        Returns: boolean
      }
      has_store_access: {
        Args: { _store_id: string; _user_id: string }
        Returns: boolean
      }
      link_user_to_store_by_email: {
        Args: {
          _email: string
          _manager_user_id: string
          _role: Database["public"]["Enums"]["app_role"]
          _store_id: string
        }
        Returns: string
      }
    }
    Enums: {
      app_role: "admin" | "gerente" | "caixa" | "estoquista" | "admin_dev"
      fiscal_env: "homologacao" | "producao"
      fiscal_provider: "none" | "focus_nfe" | "nfe_io" | "plugnotas"
      invoice_status:
        | "rascunho"
        | "processando"
        | "autorizada"
        | "rejeitada"
        | "cancelada"
        | "inutilizada"
      invoice_type: "nfce" | "nfe"
      movement_type: "entrada" | "saida" | "ajuste" | "venda" | "devolucao"
      payment_method:
        | "dinheiro"
        | "pix"
        | "debito"
        | "credito"
        | "voucher"
        | "outro"
      sale_status: "aberta" | "finalizada" | "cancelada"
      tax_regime:
        | "simples_nacional"
        | "simples_nacional_excesso"
        | "regime_normal"
        | "mei"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "gerente", "caixa", "estoquista", "admin_dev"],
      fiscal_env: ["homologacao", "producao"],
      fiscal_provider: ["none", "focus_nfe", "nfe_io", "plugnotas"],
      invoice_status: [
        "rascunho",
        "processando",
        "autorizada",
        "rejeitada",
        "cancelada",
        "inutilizada",
      ],
      invoice_type: ["nfce", "nfe"],
      movement_type: ["entrada", "saida", "ajuste", "venda", "devolucao"],
      payment_method: [
        "dinheiro",
        "pix",
        "debito",
        "credito",
        "voucher",
        "outro",
      ],
      sale_status: ["aberta", "finalizada", "cancelada"],
      tax_regime: [
        "simples_nacional",
        "simples_nacional_excesso",
        "regime_normal",
        "mei",
      ],
    },
  },
} as const
