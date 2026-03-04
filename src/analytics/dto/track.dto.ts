export class TrackDto {
  path?: string;
  device?: string;
  timezone?: string;
  event?: 'page_view' | 'page_leave' | 'signup_started' | 'signup_completed' | 'purchase' | 'like';
  sessionId?: string;
  enteredAt?: string;
  leftAt?: string;
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  /** When true, event is from a user who accepted analytics cookies; when false, do not store. */
  consent?: boolean;
}
