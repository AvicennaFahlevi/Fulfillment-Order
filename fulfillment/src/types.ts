export type Role = 'admin' | 'picker' | 'packer';
export interface User { id: string; name: string; username: string; role: Role; active: boolean }
export type OrderStatus = 'NEW' | 'READY' | 'PACKING' | 'PACKED';
export interface Item { name: string; sku: string; variant: string; quantity: number }
export interface ImportOrder { tracking: string; orderNumber: string; buyer: string; recipient: string; sourceStatus: string; items: Item[] }
export interface Order extends ImportOrder { id: string; status: OrderStatus; version: number; pickedBy: string | null; pickedAt: string | null; createdAt: string; updatedAt: string }
export interface Recording { id: string; tracking: string; orderNumber: string; packerId: string; packerName: string; station: string; status: 'RECORDING' | 'SAVED' | 'INTERRUPTED' | 'FAILED'; startedAt: string; finishedAt: string | null; duration: number; bytes: number; videoUrl: string | null; reason: string | null; clientId: string; driveFileId: string | null }
export interface DriveStatus { configured: boolean; connected: boolean; folderUrl: string | null; error?: string }
export interface Dashboard { counts: { total: number; new: number; ready: number; packing: number; packed: number }; recentOrders: Order[]; recentRecordings: Recording[] }
export interface ImportPreview { orders: ImportOrder[]; rows: number; skipped: number; warnings: string[] }
