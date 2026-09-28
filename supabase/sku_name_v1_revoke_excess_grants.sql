-- SKU_Name dang la BANG DUY NHAT cap GRANT INSERT/UPDATE/DELETE/TRUNCATE/
-- TRIGGER/REFERENCES truc tiep cho anon va authenticated, trong khi RLS
-- tren bang nay chi co dung 1 policy (SELECT USING true) - khong co policy
-- nao cho INSERT/UPDATE/DELETE, va TRUNCATE thi Postgres khong ap RLS duoc,
-- nen quyen TRUNCATE cap cho anon la mot canh cua bo ngo tren bang du lieu
-- SKU that (21k+ dong). Moi bang khac trong schema deu khong cap grant
-- truc tiep nao ca (chi qua ham SECURITY DEFINER co kiem token rieng) -
-- day la ngoai le, ro rang la quyen cap thua con sot lai.
--
-- Nguoi viet duy nhat vao bang nay la scripts/sync_sku_to_supabase.py, dung
-- SUPABASE_SECRET_KEY (service_role) - khong phu thuoc grant cua anon/
-- authenticated nen thu hoi khong anh huong. App (index.html) chi doc
-- SKU_Name qua SELECT (van con nguyen policy "Enable read access for all
-- users"), khong ghi bao gio.
begin;

revoke insert, update, delete, truncate, trigger, references
  on public."SKU_Name" from anon, authenticated;

commit;
