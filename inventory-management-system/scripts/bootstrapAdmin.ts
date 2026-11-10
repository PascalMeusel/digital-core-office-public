import { generateInventoryAdminPassword, setInventoryAdminPassword } from '../server/inventorySystem.ts'

const email = process.env.INVENTORY_SYSTEM_ADMIN_EMAIL ?? 'admin@inventory.local'
const name = process.env.INVENTORY_SYSTEM_ADMIN_NAME ?? 'Admin'
const password = process.env.INVENTORY_SYSTEM_ADMIN_PASSWORD ?? generateInventoryAdminPassword()

const user = setInventoryAdminPassword({ email, name, password })

console.log(
  JSON.stringify(
    {
      email: user.email,
      password,
      role: user.role,
    },
    null,
    2,
  ),
)
