export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="1.5" y="1.5" width="21" height="21" rx="7" fill="currentColor" opacity="0.1" />
      <path d="M5.4 7.1 8.1 17h2.35l1.56-5.45L13.6 17h2.32l2.68-9.9h-2.12l-1.78 7.2-1.8-6.08h-1.78l-1.8 6.08-1.8-7.2H5.4Z" fill="currentColor" />
    </svg>
  )
}
