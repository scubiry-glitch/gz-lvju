'use strict';

// Existing entry point, backed by the shared durable payment state machine.
const { createPaymentCore } = require('./server/payment/core.cjs');
const { createBookingPaymentAdapter } = require('./server/payment/booking-adapter.cjs');
const { createBookingCompatibility } = require('./server/payment/booking-compat.cjs');
const { generateAppOrderId, notificationKey } = require('./server/payment/primitives.cjs');

function createPaymentService(options = {}) {
  const jobHandlers = { ...options.jobHandlers };
  if (!jobHandlers.booking_webhook && typeof options.notifyVendorBooking === 'function') {
    jobHandlers.booking_webhook = job => options.notifyVendorBooking(job.payload.vendorId, job.payload.event, job.payload.order);
  }
  const core = createPaymentCore({ ...options, jobHandlers });
  const bookingAdapter = createBookingPaymentAdapter({ ...options, core });
  return {
    core,
    bookingAdapter,
    ...createBookingCompatibility({ ...options, core, bookingAdapter }),
  };
}

module.exports = { createPaymentService, generateAppOrderId, notificationKey };
