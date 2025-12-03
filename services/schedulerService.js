const Stream = require('../models/Stream');
const scheduledTerminations = new Map();
const SCHEDULE_LOOKAHEAD_SECONDS = 60;
let streamingService = null;
function init(streamingServiceInstance) {
  streamingService = streamingServiceInstance;
  console.log('Stream scheduler initialized');
  setInterval(checkScheduledStreams, 60 * 1000);
  setInterval(checkStreamDurations, 10 * 1000);
  setInterval(checkAutoDailyLiveStreams, 60 * 1000);
  checkScheduledStreams();
  checkStreamDurations();
  checkAutoDailyLiveStreams();
}
async function checkScheduledStreams() {
  try {
    if (!streamingService) {
      console.error('StreamingService not initialized in scheduler');
      return;
    }
    const now = new Date();
    const lookAheadTime = new Date(now.getTime() + SCHEDULE_LOOKAHEAD_SECONDS * 1000);
    console.log(`Checking for scheduled streams (${now.toISOString()} to ${lookAheadTime.toISOString()})`);
    const streams = await Stream.findScheduledInRange(now, lookAheadTime);
    if (streams.length > 0) {
      console.log(`Found ${streams.length} streams to schedule start`);
      for (const stream of streams) {
        console.log(`Starting scheduled stream: ${stream.id} - ${stream.title}`);
        const result = await streamingService.startStream(stream.id);
        if (result.success) {
          console.log(`Successfully started scheduled stream: ${stream.id}`);
          if (stream.duration) {
            scheduleStreamTermination(stream.id, stream.duration);
          }
        } else {
          console.error(`Failed to start scheduled stream ${stream.id}: ${result.error}`);
        }
      }
    }
  } catch (error) {
    console.error('Error checking scheduled streams:', error);
  }
}
async function checkStreamDurations() {
  try {
    if (!streamingService) {
      console.error('StreamingService not initialized in scheduler');
      return;
    }
    const liveStreams = await Stream.findAll(null, 'live');
    const now = new Date();
    
    for (const stream of liveStreams) {
      if (stream.duration && stream.start_time) {
        const startTime = new Date(stream.start_time);
        const durationMs = stream.duration * 60 * 1000;
        const shouldEndAt = new Date(startTime.getTime() + durationMs);
        const timeUntilEnd = shouldEndAt.getTime() - now.getTime();
        
        if (timeUntilEnd <= 0) {
          console.log(`[SchedulerService] Stream ${stream.id} exceeded duration by ${Math.abs(timeUntilEnd / 1000)}s, stopping immediately`);
          if (scheduledTerminations.has(stream.id)) {
            clearTimeout(scheduledTerminations.get(stream.id));
            scheduledTerminations.delete(stream.id);
          }
          await streamingService.stopStream(stream.id);
        } else if (!scheduledTerminations.has(stream.id)) {
          console.log(`[SchedulerService] Stream ${stream.id} will end in ${Math.round(timeUntilEnd / 1000)}s, scheduling termination`);
          scheduleStreamTermination(stream.id, timeUntilEnd / 60000);
        }
      }
    }
  } catch (error) {
    console.error('Error checking stream durations:', error);
  }
}
function scheduleStreamTermination(streamId, durationMinutes) {
  if (scheduledTerminations.has(streamId)) {
    clearTimeout(scheduledTerminations.get(streamId));
    console.log(`[SchedulerService] Clearing existing termination schedule for stream ${streamId}`);
  }
  const durationMs = Math.max(1000, durationMinutes * 60 * 1000);
  console.log(`[SchedulerService] Scheduling termination for stream ${streamId} after ${durationMinutes.toFixed(2)} minutes (${Math.round(durationMs / 1000)}s)`);
  const timeoutId = setTimeout(async () => {
    try {
      console.log(`[SchedulerService] Terminating stream ${streamId} after scheduled duration of ${durationMinutes.toFixed(2)} minutes`);
      scheduledTerminations.delete(streamId);
      await streamingService.stopStream(streamId);
    } catch (error) {
      console.error(`[SchedulerService] Error terminating stream ${streamId}:`, error);
      scheduledTerminations.delete(streamId);
    }
  }, durationMs);
  scheduledTerminations.set(streamId, timeoutId);
}
function cancelStreamTermination(streamId) {
  if (scheduledTerminations.has(streamId)) {
    clearTimeout(scheduledTerminations.get(streamId));
    scheduledTerminations.delete(streamId);
    console.log(`Cancelled scheduled termination for stream ${streamId}`);
    return true;
  }
  return false;
}
function handleStreamStopped(streamId) {
  return cancelStreamTermination(streamId);
}
async function checkAutoDailyLiveStreams() {
  try {
    if (!streamingService) {
      console.error('StreamingService not initialized in scheduler');
      return;
    }
    const autoDailyStreams = await Stream.findAutoDailyLive();
    if (autoDailyStreams.length === 0) {
      return;
    }
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    for (const stream of autoDailyStreams) {
      if (stream.daily_start_time === currentTime && stream.status === 'offline') {
        console.log(`Starting auto daily live stream: ${stream.id} - ${stream.title} at ${currentTime}`);
        const result = await streamingService.startStream(stream.id);
        if (result.success) {
          console.log(`Successfully started auto daily live stream: ${stream.id}`);
          if (stream.duration) {
            scheduleStreamTermination(stream.id, stream.duration);
          }
        } else {
          console.error(`Failed to start auto daily live stream ${stream.id}: ${result.error}`);
        }
      }
    }
  } catch (error) {
    console.error('Error checking auto daily live streams:', error);
  }
}
module.exports = {
  init,
  scheduleStreamTermination,
  cancelStreamTermination,
  handleStreamStopped
};