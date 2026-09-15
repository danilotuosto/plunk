/**
 * Email queue job data types
 */

/**
 * Job data for sending a single email
 * Used by: emailQueue worker
 */
export interface SendEmailJobData {
  emailId: string;
  /**
   * Number of times this email has already been re-queued after hitting
   * `AllProvidersExhaustedError`. Carried on the job (rather than read from
   * `job.attemptsMade`) because each requeue is a fresh BullMQ job under a new
   * id, so attemptsMade would reset to 0 every time.
   */
  attempt?: number;
}

/**
 * Job data for recording a Stripe meter event
 * Used by: meterQueue worker
 */
export interface MeterEventJobData {
  customerId: string;
  value: number;
  idempotencyKey?: string;
}
