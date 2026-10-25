CREATE SCHEMA IF NOT EXISTS restaurant_data;
CREATE SCHEMA IF NOT EXISTS order_data;
CREATE SCHEMA IF NOT EXISTS delivery_data;

CREATE TABLE restaurant_data.restaurants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cuisine TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE restaurant_data.menu_items (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurant_data.restaurants(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX menu_items_restaurant_id_idx ON restaurant_data.menu_items(restaurant_id);

CREATE TABLE order_data.demo_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'delivery_partner'))
);

CREATE TABLE order_data.orders (
  id UUID PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  restaurant_name TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES order_data.demo_users(id),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'accepted', 'rejected', 'preparing', 'ready_for_pickup',
    'picked_up', 'delivered'
  )),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX orders_customer_created_idx ON order_data.orders(customer_id, created_at DESC);
CREATE INDEX orders_restaurant_status_idx ON order_data.orders(restaurant_id, status);

CREATE TABLE order_data.restaurant_order_state (
  order_id UUID PRIMARY KEY REFERENCES order_data.orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'preparing', 'ready_for_pickup')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX restaurant_order_state_status_idx ON order_data.restaurant_order_state(status);

CREATE TABLE order_data.order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES order_data.orders(id) ON DELETE CASCADE,
  menu_item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0)
);

CREATE INDEX order_items_order_id_idx ON order_data.order_items(order_id);

CREATE TABLE delivery_data.deliveries (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL UNIQUE,
  restaurant_id TEXT NOT NULL,
  restaurant_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'accepted', 'picked_up', 'delivered')),
  delivery_partner_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX deliveries_status_created_idx ON delivery_data.deliveries(status, created_at);

INSERT INTO restaurant_data.restaurants (id, name, cuisine) VALUES
  ('restaurant-spice-garden', 'Spice Garden', 'Indian'),
  ('restaurant-pasta-house', 'Pasta House', 'Italian');

INSERT INTO restaurant_data.menu_items (id, restaurant_id, name, description, price_cents) VALUES
  ('item-butter-chicken', 'restaurant-spice-garden', 'Butter Chicken', 'Creamy tomato curry with tender chicken.', 1599),
  ('item-paneer-tikka', 'restaurant-spice-garden', 'Paneer Tikka', 'Char-grilled paneer with house spices.', 1199),
  ('item-dal-makhani', 'restaurant-spice-garden', 'Dal Makhani', 'Slow-cooked black lentils.', 999),
  ('item-garlic-naan', 'restaurant-spice-garden', 'Garlic Naan', 'Soft naan topped with garlic and herbs.', 299),
  ('item-basmati-rice', 'restaurant-spice-garden', 'Basmati Rice', 'Fragrant steamed basmati rice.', 349),
  ('item-margherita', 'restaurant-pasta-house', 'Margherita Pizza', 'Tomato, mozzarella and fresh basil.', 1399),
  ('item-alfredo-pasta', 'restaurant-pasta-house', 'Alfredo Pasta', 'Penne in a creamy parmesan sauce.', 1299),
  ('item-lasagna', 'restaurant-pasta-house', 'Classic Lasagna', 'Layered pasta, slow-cooked sauce and cheese.', 1499),
  ('item-caprese-salad', 'restaurant-pasta-house', 'Caprese Salad', 'Tomato, mozzarella and basil.', 899),
  ('item-tiramisu', 'restaurant-pasta-house', 'Tiramisu', 'Espresso-soaked sponge with mascarpone.', 599);

INSERT INTO order_data.demo_users (id, display_name, role) VALUES
  ('customer-demo', 'Demo Customer', 'customer'),
  ('delivery-partner-demo', 'Demo Delivery Partner', 'delivery_partner');
