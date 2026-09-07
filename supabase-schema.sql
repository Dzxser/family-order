-- ================================================================
-- 家庭点餐 - Supabase 数据库初始化脚本
-- 在 Supabase Dashboard → SQL Editor → New Query 里粘贴运行
-- ================================================================

-- 1. 分类表
CREATE TABLE IF NOT EXISTS categories (
  id        serial PRIMARY KEY,
  name      text NOT NULL UNIQUE,
  sort_order int DEFAULT 0
);

-- 2. 菜品表
CREATE TABLE IF NOT EXISTS dishes (
  id        text PRIMARY KEY,          -- 前端生成的时间戳 ID
  name      text NOT NULL,
  category  text NOT NULL,
  "desc"    text DEFAULT '',
  price     numeric DEFAULT 0,
  recipe    text DEFAULT '',
  image     text,                      -- Supabase Storage 公开 URL
  created_at timestamptz DEFAULT now()
);

-- 3. 订单表
CREATE TABLE IF NOT EXISTS orders (
  id        text PRIMARY KEY,          -- 前端生成的时间戳 ID
  items     jsonb NOT NULL,            -- [{dishId, name, price, qty}]
  note      text DEFAULT '',
  total     numeric DEFAULT 0,
  status    text DEFAULT 'pending',    -- pending / done
  time      bigint,                    -- 毫秒时间戳
  created_at timestamptz DEFAULT now()
);

-- 4. 设置表（存管理员密码等）
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text
);

-- 5. 插入默认数据
INSERT INTO categories (name, sort_order) VALUES
  ('蔬菜', 1), ('凉拌菜', 2), ('腌制', 3), ('羹汤', 4),
  ('荤菜', 5), ('小炒', 6), ('饮料', 7), ('其他', 8)
ON CONFLICT (name) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('adminPwd', '123456')
ON CONFLICT (key) DO NOTHING;

-- ================================================================
-- RLS 策略：允许匿名访问（家庭应用，不需要用户登录）
-- ================================================================
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE dishes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings  ENABLE ROW LEVEL SECURITY;

-- 允许所有人读写（家庭场景，安全性靠 anon key 保密）
CREATE POLICY "allow_all_categories" ON categories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_dishes"     ON dishes     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_orders"     ON orders     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_settings"   ON settings   FOR ALL USING (true) WITH CHECK (true);

-- ================================================================
-- Storage：菜品图片存储
-- ================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('dish-images', 'dish-images', true)
ON CONFLICT (id) DO NOTHING;

-- Storage 策略：允许匿名上传和读取
CREATE POLICY "allow_upload_dish_images" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'dish-images');

CREATE POLICY "allow_read_dish_images" ON storage.objects
  FOR SELECT USING (bucket_id = 'dish-images');

-- ================================================================
-- Realtime：启用表变更推送
-- ================================================================
ALTER TABLE dishes     REPLICA IDENTITY FULL;
ALTER TABLE categories REPLICA IDENTITY FULL;
ALTER TABLE orders     REPLICA IDENTITY FULL;
ALTER TABLE settings   REPLICA IDENTITY FULL;

-- 在 Supabase Dashboard → Database → Replication → 确认以上 4 张表已勾选
