/** Property-type icons (lucide, imported individually per §12). */
import {
  AlignLeft, ArrowUpRight, AtSign, BarChart3, Binary, Calendar, CalendarClock, CheckSquare, CircleDot, Clock, Hash, Link2, List,
  ListChecks, Lock, Paperclip, Phone, Repeat, Search, Sigma, Star, Tag, Type, CandlestickChart, Fingerprint, Loader, DollarSign,
  Cpu,
} from 'lucide-react';
import type { PropType } from '@/backend/types';
import type { IconComponent } from '@/ui/Button';

export const TYPE_ICON: Record<PropType, IconComponent> = {
  title: Type,
  text: AlignLeft,
  number: Hash,
  money: DollarSign,
  select: CircleDot,
  multi_select: List,
  status: Loader,
  date: Calendar,
  checkbox: CheckSquare,
  url: Link2,
  email: AtSign,
  phone: Phone,
  files: Paperclip,
  relation: ArrowUpRight,
  rollup: Search,
  formula: Sigma,
  created_time: CalendarClock,
  updated_time: Clock,
  unique_id: Fingerprint,
  rating: Star,
  progress: BarChart3,
  ticker: CandlestickChart,
  recurrence: Repeat,
  secret: Lock,
  computed: Cpu,
};

export function TypeIcon({ type, size = 14, className }: { type: PropType; size?: number; className?: string }) {
  const I = TYPE_ICON[type] ?? Binary;
  return <I size={size} className={className} aria-hidden />;
}

export { Tag as TagIcon, ListChecks };
