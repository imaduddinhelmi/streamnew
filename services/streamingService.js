const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const schedulerService = require('./schedulerService');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const Stream = require('../models/Stream');
const Playlist = require('../models/Playlist');

// Helper function to forcefully kill FFmpeg process (platform-aware)
function forceKillProcess(ffmpegProcess, pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve(false);
      return;
    }

    if (process.platform === 'win32') {
      // Windows: use taskkill with /T to kill child processes too
      exec(`taskkill /pid ${pid} /f /t`, (err) => {
        if (err) {
          console.log(`[StreamingService] taskkill error (may already be dead): ${err.message}`);
        }
        resolve(!err);
      });
    } else {
      // Unix: use SIGKILL
      try {
        ffmpegProcess.kill('SIGKILL');
        resolve(true);
      } catch (e) {
        console.log(`[StreamingService] SIGKILL error: ${e.message}`);
        resolve(false);
      }
    }
  });
}
let ffmpegPath;
if (fs.existsSync('/usr/bin/ffmpeg')) {
  ffmpegPath = '/usr/bin/ffmpeg';
  console.log('Using system FFmpeg at:', ffmpegPath);
} else {
  ffmpegPath = ffmpegInstaller.path;
  console.log('Using bundled FFmpeg at:', ffmpegPath);
}
const Video = require('../models/Video');
const activeStreams = new Map();
const streamLogs = new Map();
const streamRetryCount = new Map();
const MAX_RETRY_ATTEMPTS = 3;
const manuallyStoppingStreams = new Set();
const MAX_LOG_LINES = 100;
function addStreamLog(streamId, message) {
  if (!streamLogs.has(streamId)) {
    streamLogs.set(streamId, []);
  }
  const logs = streamLogs.get(streamId);
  logs.push({
    timestamp: new Date().toISOString(),
    message
  });
  if (logs.length > MAX_LOG_LINES) {
    logs.shift();
  }
}
async function buildFFmpegArgsForPlaylist(stream, playlist) {
  if (!playlist.videos || playlist.videos.length === 0) {
    throw new Error(`Playlist is empty for playlist_id: ${stream.video_id}`);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;

  let videoPaths = [];

  if (playlist.is_shuffle || playlist.shuffle) {
    const shuffledVideos = [...playlist.videos].sort(() => Math.random() - 0.5);
    videoPaths = shuffledVideos.map(video => {
      const relativeVideoPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
      return path.join(projectRoot, 'public', relativeVideoPath);
    });
  } else {
    videoPaths = playlist.videos.map(video => {
      const relativeVideoPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
      return path.join(projectRoot, 'public', relativeVideoPath);
    });
  }

  for (const videoPath of videoPaths) {
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }
  }

  const concatFile = path.join(projectRoot, 'temp', `playlist_${stream.id}.txt`);

  const tempDir = path.dirname(concatFile);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  let concatContent = '';
  if (stream.loop_video) {
    for (let i = 0; i < 1000; i++) {
      videoPaths.forEach(videoPath => {
        concatContent += `file '${videoPath.replace(/\\/g, '/')}'\n`;
      });
    }
  } else {
    videoPaths.forEach(videoPath => {
      concatContent += `file '${videoPath.replace(/\\/g, '/')}'\n`;
    });
  }

  fs.writeFileSync(concatFile, concatContent);

  if (!stream.use_advanced_settings) {
    return [
      '-hwaccel', 'auto',
      '-loglevel', 'info',
      '-re',
      '-fflags', '+genpts+igndts',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-flags', '+global_header',
      '-bufsize', '4M',
      '-max_muxing_queue_size', '7000',
      '-f', 'flv',
      rtmpUrl
    ];
  }

  const resolution = stream.resolution || '1280x720';
  const bitrate = stream.bitrate || 2500;
  const fps = stream.fps || 30;

  return [
    '-hwaccel', 'auto',
    '-loglevel', 'info',
    '-re',
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatFile,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${bitrate * 1.5}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', `${fps * 2}`,
    '-s', resolution,
    '-r', fps.toString(),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    rtmpUrl
  ];
}

async function buildFFmpegArgs(stream) {
  const streamWithVideo = await Stream.getStreamWithVideo(stream.id);

  if (streamWithVideo && streamWithVideo.video_type === 'playlist') {
    const Playlist = require('../models/Playlist');
    const playlist = await Playlist.findByIdWithVideos(stream.video_id);

    if (!playlist) {
      throw new Error(`Playlist not found for playlist_id: ${stream.video_id}`);
    }

    return await buildFFmpegArgsForPlaylist(stream, playlist);
  }

  const video = await Video.findById(stream.video_id);
  if (!video) {
    throw new Error(`Video record not found in database for video_id: ${stream.video_id}`);
  }

  const relativeVideoPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
  const projectRoot = path.resolve(__dirname, '..');
  const videoPath = path.join(projectRoot, 'public', relativeVideoPath);

  if (!fs.existsSync(videoPath)) {
    console.error(`[StreamingService] CRITICAL: Video file not found on disk.`);
    console.error(`[StreamingService] Checked path: ${videoPath}`);
    console.error(`[StreamingService] stream.video_id: ${stream.video_id}`);
    console.error(`[StreamingService] video.filepath (from DB): ${video.filepath}`);
    console.error(`[StreamingService] Calculated relativeVideoPath: ${relativeVideoPath}`);
    console.error(`[StreamingService] process.cwd(): ${process.cwd()}`);
    throw new Error('Video file not found on disk. Please check paths and file existence.');
  }

  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;
  const loopArgs = stream.loop_video ? ['-stream_loop', '-1'] : ['-stream_loop', '0'];
  if (!stream.use_advanced_settings) {
    return [
      '-hwaccel', 'auto',
      '-loglevel', 'info',
      '-re',
      '-fflags', '+genpts+igndts',
      '-avoid_negative_ts', 'make_zero',
      ...loopArgs,
      '-i', videoPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-flags', '+global_header',
      '-bufsize', '4M',
      '-max_muxing_queue_size', '7000',
      '-f', 'flv',
      rtmpUrl
    ];
  }
  const resolution = stream.resolution || '1280x720';
  const bitrate = stream.bitrate || 2500;
  const fps = stream.fps || 30;
  return [
    '-hwaccel', 'auto',
    '-loglevel', 'info',
    '-re',
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    ...loopArgs,
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${bitrate * 1.5}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', `${fps * 2}`,
    '-s', resolution,
    '-r', fps.toString(),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    rtmpUrl
  ];
}
async function startStream(streamId) {
  try {
    streamRetryCount.set(streamId, 0);
    if (activeStreams.has(streamId)) {
      return { success: false, error: 'Stream is already active' };
    }
    const stream = await Stream.findById(streamId);
    if (!stream) {
      return { success: false, error: 'Stream not found' };
    }
    const ffmpegArgs = await buildFFmpegArgs(stream);
    const fullCommand = `${ffmpegPath} ${ffmpegArgs.join(' ')}`;
    addStreamLog(streamId, `Starting stream with command: ${fullCommand}`);
    console.log(`Starting stream: ${fullCommand}`);
    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activeStreams.set(streamId, ffmpegProcess);
    await Stream.updateStatus(streamId, 'live', stream.user_id);
    ffmpegProcess.stdout.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        addStreamLog(streamId, `[OUTPUT] ${message}`);
        console.log(`[FFMPEG_STDOUT] ${streamId}: ${message}`);
      }
    });
    ffmpegProcess.stderr.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        addStreamLog(streamId, `[FFmpeg] ${message}`);
        if (!message.includes('frame=')) {
          console.error(`[FFMPEG_STDERR] ${streamId}: ${message}`);
        }
      }
    });
    ffmpegProcess.on('exit', async (code, signal) => {
      addStreamLog(streamId, `Stream ended with code ${code}, signal: ${signal}`);
      console.log(`[FFMPEG_EXIT] ${streamId}: Code=${code}, Signal=${signal}`);
      const wasActive = activeStreams.delete(streamId);
      const isManualStop = manuallyStoppingStreams.has(streamId);

      const stream = await Stream.findById(streamId);

      if (isManualStop) {
        console.log(`[StreamingService] Stream ${streamId} was manually stopped, not restarting`);
        manuallyStoppingStreams.delete(streamId);
        if (wasActive) {
          try {
            await Stream.updateStatus(streamId, 'offline', stream?.user_id);
            if (typeof schedulerService !== 'undefined' && schedulerService.handleStreamStopped) {
              schedulerService.handleStreamStopped(streamId);
            }
          } catch (error) {
            console.error(`[StreamingService] Error updating stream status after manual stop: ${error.message}`);
          }
        }
        return;
      }
      if (signal === 'SIGSEGV') {
        const retryCount = streamRetryCount.get(streamId) || 0;
        if (retryCount < MAX_RETRY_ATTEMPTS) {
          streamRetryCount.set(streamId, retryCount + 1);
          console.log(`[StreamingService] FFmpeg crashed with SIGSEGV. Attempting restart #${retryCount + 1} for stream ${streamId}`);
          addStreamLog(streamId, `FFmpeg crashed with SIGSEGV. Attempting restart #${retryCount + 1}`);
          setTimeout(async () => {
            try {
              const streamInfo = await Stream.findById(streamId);
              if (streamInfo) {
                const result = await startStream(streamId);
                if (!result.success) {
                  console.error(`[StreamingService] Failed to restart stream: ${result.error}`);
                  await Stream.updateStatus(streamId, 'offline', streamInfo.user_id);
                  if (typeof schedulerService !== 'undefined' && schedulerService.handleStreamStopped) {
                    schedulerService.handleStreamStopped(streamId);
                  }
                } else {
                  if (streamInfo.duration && typeof schedulerService !== 'undefined') {
                    const elapsed = stream.start_time ? (Date.now() - new Date(stream.start_time).getTime()) / 60000 : 0;
                    const remainingDuration = Math.max(0, streamInfo.duration - elapsed);
                    if (remainingDuration > 0) {
                      schedulerService.scheduleStreamTermination(streamId, remainingDuration);
                    }
                  }
                }
              } else {
                console.error(`[StreamingService] Cannot restart stream ${streamId}: not found in database`);
              }
            } catch (error) {
              console.error(`[StreamingService] Error during stream restart: ${error.message}`);
              try {
                const streamInfo = await Stream.findById(streamId);
                await Stream.updateStatus(streamId, 'offline', streamInfo?.user_id);
                if (typeof schedulerService !== 'undefined' && schedulerService.handleStreamStopped) {
                  schedulerService.handleStreamStopped(streamId);
                }
              } catch (dbError) {
                console.error(`Error updating stream status: ${dbError.message}`);
              }
            }
          }, 3000);
          return;
        } else {
          console.error(`[StreamingService] Maximum retry attempts (${MAX_RETRY_ATTEMPTS}) reached for stream ${streamId}`);
          addStreamLog(streamId, `Maximum retry attempts (${MAX_RETRY_ATTEMPTS}) reached, stopping stream`);
        }
      }
      else {
        let errorMessage = '';
        if (code !== 0 && code !== null) {
          errorMessage = `FFmpeg process exited with error code ${code}`;
          addStreamLog(streamId, errorMessage);
          console.error(`[StreamingService] ${errorMessage} for stream ${streamId}`);
          const retryCount = streamRetryCount.get(streamId) || 0;
          if (retryCount < MAX_RETRY_ATTEMPTS) {
            streamRetryCount.set(streamId, retryCount + 1);
            console.log(`[StreamingService] FFmpeg exited with code ${code}. Attempting restart #${retryCount + 1} for stream ${streamId}`);
            setTimeout(async () => {
              try {
                const streamInfo = await Stream.findById(streamId);
                if (streamInfo) {
                  const result = await startStream(streamId);
                  if (!result.success) {
                    console.error(`[StreamingService] Failed to restart stream: ${result.error}`);
                    await Stream.updateStatus(streamId, 'offline', streamInfo.user_id);
                    if (typeof schedulerService !== 'undefined' && schedulerService.handleStreamStopped) {
                      schedulerService.handleStreamStopped(streamId);
                    }
                  } else {
                    if (streamInfo.duration && typeof schedulerService !== 'undefined') {
                      const elapsed = stream.start_time ? (Date.now() - new Date(stream.start_time).getTime()) / 60000 : 0;
                      const remainingDuration = Math.max(0, streamInfo.duration - elapsed);
                      if (remainingDuration > 0) {
                        schedulerService.scheduleStreamTermination(streamId, remainingDuration);
                      }
                    }
                  }
                }
              } catch (error) {
                console.error(`[StreamingService] Error during stream restart: ${error.message}`);
                const streamInfo = await Stream.findById(streamId);
                await Stream.updateStatus(streamId, 'offline', streamInfo?.user_id);
                if (typeof schedulerService !== 'undefined' && schedulerService.handleStreamStopped) {
                  schedulerService.handleStreamStopped(streamId);
                }
              }
            }, 3000);
            return;
          }
        }
        if (wasActive) {
          try {
            console.log(`[StreamingService] Updating stream ${streamId} status to offline after FFmpeg exit`);
            await Stream.updateStatus(streamId, 'offline', stream?.user_id);
            if (typeof schedulerService !== 'undefined' && schedulerService.handleStreamStopped) {
              schedulerService.handleStreamStopped(streamId);
            }
          } catch (error) {
            console.error(`[StreamingService] Error updating stream status after exit: ${error.message}`);
          }
        }
      }
    });
    ffmpegProcess.on('error', async (err) => {
      addStreamLog(streamId, `Error in stream process: ${err.message}`);
      console.error(`[FFMPEG_PROCESS_ERROR] ${streamId}: ${err.message}`);
      activeStreams.delete(streamId);
      try {
        const stream = await Stream.findById(streamId);
        await Stream.updateStatus(streamId, 'offline', stream?.user_id);
        if (typeof schedulerService !== 'undefined' && schedulerService.handleStreamStopped) {
          schedulerService.handleStreamStopped(streamId);
        }
      } catch (error) {
        console.error(`Error updating stream status: ${error.message}`);
      }
    });
    ffmpegProcess.unref();
    if (stream.duration && typeof schedulerService !== 'undefined') {
      schedulerService.scheduleStreamTermination(streamId, stream.duration);
    }
    return {
      success: true,
      message: 'Stream started successfully',
      isAdvancedMode: stream.use_advanced_settings
    };
  } catch (error) {
    addStreamLog(streamId, `Failed to start stream: ${error.message}`);
    console.error(`Error starting stream ${streamId}:`, error);
    return { success: false, error: error.message };
  }
}
async function stopStream(streamId) {
  try {
    const ffmpegProcess = activeStreams.get(streamId);
    const isActive = ffmpegProcess !== undefined;
    console.log(`[StreamingService] Stop request for stream ${streamId}, isActive: ${isActive}`);
    if (!isActive) {
      const stream = await Stream.findById(streamId);
      if (stream && stream.status === 'live') {
        console.log(`[StreamingService] Stream ${streamId} not active in memory but status is 'live' in DB. Fixing status.`);
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        if (typeof schedulerService !== 'undefined' && schedulerService.cancelStreamTermination) {
          schedulerService.handleStreamStopped(streamId);
        }
        return { success: true, message: 'Stream status fixed (was not active but marked as live)' };
      }
      return { success: false, error: 'Stream is not active' };
    }
    addStreamLog(streamId, 'Stopping stream...');
    console.log(`[StreamingService] Stopping active stream ${streamId}`);
    manuallyStoppingStreams.add(streamId);

    const pid = ffmpegProcess.pid;
    let killed = false;

    // Try graceful SIGTERM first
    try {
      ffmpegProcess.kill('SIGTERM');
      console.log(`[StreamingService] Sent SIGTERM to process ${pid}`);
    } catch (killError) {
      console.error(`[StreamingService] Error sending SIGTERM: ${killError.message}`);
    }

    // Wait up to 3 seconds for process to exit gracefully
    const exitPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[StreamingService] Timeout waiting for process ${pid} to exit`);
        resolve(false);
      }, 3000);

      ffmpegProcess.once('exit', () => {
        clearTimeout(timeout);
        console.log(`[StreamingService] Process ${pid} exited gracefully`);
        resolve(true);
      });
    });

    killed = await exitPromise;

    // If still running after timeout, force kill
    if (!killed && pid) {
      console.log(`[StreamingService] SIGTERM failed for stream ${streamId}, using force kill on PID ${pid}`);
      addStreamLog(streamId, 'Force killing process...');
      await forceKillProcess(ffmpegProcess, pid);
      // Give it a moment to actually die
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const stream = await Stream.findById(streamId);
    activeStreams.delete(streamId);

    const tempConcatFile = path.join(__dirname, '..', 'temp', `playlist_${streamId}.txt`);
    try {
      if (fs.existsSync(tempConcatFile)) {
        fs.unlinkSync(tempConcatFile);
        console.log(`[StreamingService] Cleaned up temporary playlist file: ${tempConcatFile}`);
      }
    } catch (cleanupError) {
      console.error(`[StreamingService] Error cleaning up temporary file: ${cleanupError.message}`);
    }

    if (stream) {
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
      const updatedStream = await Stream.findById(streamId);
      await saveStreamHistory(updatedStream);
    }
    if (typeof schedulerService !== 'undefined' && schedulerService.cancelStreamTermination) {
      schedulerService.handleStreamStopped(streamId);
    }
    return { success: true, message: 'Stream stopped successfully' };
  } catch (error) {
    manuallyStoppingStreams.delete(streamId);
    console.error(`[StreamingService] Error stopping stream ${streamId}:`, error);
    return { success: false, error: error.message };
  }
}
async function syncStreamStatuses() {
  try {
    console.log('[StreamingService] Syncing stream statuses...');
    const liveStreams = await Stream.findAll(null, 'live');
    for (const stream of liveStreams) {
      const isReallyActive = activeStreams.has(stream.id);
      if (!isReallyActive) {
        console.log(`[StreamingService] Found inconsistent stream ${stream.id}: marked as 'live' in DB but not active in memory`);
        await Stream.updateStatus(stream.id, 'offline', stream.user_id);
        if (typeof schedulerService !== 'undefined' && schedulerService.handleStreamStopped) {
          schedulerService.handleStreamStopped(stream.id);
        }
        console.log(`[StreamingService] Updated stream ${stream.id} status to 'offline'`);
      }
    }
    const activeStreamIds = Array.from(activeStreams.keys());
    for (const streamId of activeStreamIds) {
      const stream = await Stream.findById(streamId);
      if (!stream || stream.status !== 'live') {
        console.log(`[StreamingService] Found inconsistent stream ${streamId}: active in memory but not 'live' in DB`);
        if (stream) {
          await Stream.updateStatus(streamId, 'live', stream.user_id);
          console.log(`[StreamingService] Updated stream ${streamId} status to 'live'`);
        } else {
          console.log(`[StreamingService] Stream ${streamId} not found in DB, removing from active streams`);
          const process = activeStreams.get(streamId);
          if (process) {
            try {
              process.kill('SIGTERM');
            } catch (error) {
              console.error(`[StreamingService] Error killing orphaned process: ${error.message}`);
            }
          }
          activeStreams.delete(streamId);
          if (typeof schedulerService !== 'undefined' && schedulerService.handleStreamStopped) {
            schedulerService.handleStreamStopped(streamId);
          }
        }
      }
    }
    console.log(`[StreamingService] Stream status sync completed. Active streams: ${activeStreamIds.length}`);
  } catch (error) {
    console.error('[StreamingService] Error syncing stream statuses:', error);
  }
}
setInterval(syncStreamStatuses, 5 * 60 * 1000);
function isStreamActive(streamId) {
  return activeStreams.has(streamId);
}
function getActiveStreams() {
  return Array.from(activeStreams.keys());
}
function getStreamLogs(streamId) {
  return streamLogs.get(streamId) || [];
}
async function saveStreamHistory(stream) {
  try {
    if (!stream.start_time) {
      console.log(`[StreamingService] Not saving history for stream ${stream.id} - no start time recorded`);
      return false;
    }
    const startTime = new Date(stream.start_time);
    const endTime = stream.end_time ? new Date(stream.end_time) : new Date();
    const durationSeconds = Math.floor((endTime - startTime) / 1000);
    if (durationSeconds < 1) {
      console.log(`[StreamingService] Not saving history for stream ${stream.id} - duration too short (${durationSeconds}s)`);
      return false;
    }
    const videoDetails = stream.video_id ? await Video.findById(stream.video_id) : null;
    const historyData = {
      id: uuidv4(),
      stream_id: stream.id,
      title: stream.title,
      platform: stream.platform || 'Custom',
      platform_icon: stream.platform_icon,
      video_id: stream.video_id,
      video_title: videoDetails ? videoDetails.title : null,
      resolution: stream.resolution,
      bitrate: stream.bitrate,
      fps: stream.fps,
      start_time: stream.start_time,
      end_time: stream.end_time || new Date().toISOString(),
      duration: durationSeconds,
      use_advanced_settings: stream.use_advanced_settings ? 1 : 0,
      user_id: stream.user_id
    };
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stream_history (
          id, stream_id, title, platform, platform_icon, video_id, video_title,
          resolution, bitrate, fps, start_time, end_time, duration, use_advanced_settings, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyData.id, historyData.stream_id, historyData.title,
          historyData.platform, historyData.platform_icon, historyData.video_id, historyData.video_title,
          historyData.resolution, historyData.bitrate, historyData.fps,
          historyData.start_time, historyData.end_time, historyData.duration,
          historyData.use_advanced_settings, historyData.user_id
        ],
        function (err) {
          if (err) {
            console.error('[StreamingService] Error saving stream history:', err.message);
            return reject(err);
          }
          console.log(`[StreamingService] Stream history saved for stream ${stream.id}, duration: ${durationSeconds}s`);
          resolve(historyData);
        }
      );
    });
  } catch (error) {
    console.error('[StreamingService] Failed to save stream history:', error);
    return false;
  }
}

async function startAllStreams(userId) {
  try {
    console.log(`[StreamingService] Starting all streams for user ${userId}`);
    const streams = await Stream.findAll(userId, 'offline');

    const results = {
      success: [],
      failed: [],
      total: streams.length
    };

    for (const stream of streams) {
      if (!stream.video_id) {
        results.failed.push({
          id: stream.id,
          title: stream.title,
          error: 'No video attached'
        });
        continue;
      }

      const result = await startStream(stream.id);

      if (result.success) {
        results.success.push({
          id: stream.id,
          title: stream.title
        });
      } else {
        results.failed.push({
          id: stream.id,
          title: stream.title,
          error: result.error
        });
      }

      // Add small delay between starts to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`[StreamingService] Started ${results.success.length}/${results.total} streams for user ${userId}`);

    return {
      success: true,
      results
    };
  } catch (error) {
    console.error('[StreamingService] Error starting all streams:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

async function stopAllStreams(userId) {
  try {
    console.log(`[StreamingService] Stopping all streams for user ${userId}`);
    const streams = await Stream.findAll(userId, 'live');

    const results = {
      success: [],
      failed: [],
      total: streams.length
    };

    for (const stream of streams) {
      const result = await stopStream(stream.id);

      if (result.success) {
        results.success.push({
          id: stream.id,
          title: stream.title
        });
      } else {
        results.failed.push({
          id: stream.id,
          title: stream.title,
          error: result.error
        });
      }

      // Add small delay between stops
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`[StreamingService] Stopped ${results.success.length}/${results.total} streams for user ${userId}`);

    return {
      success: true,
      results
    };
  } catch (error) {
    console.error('[StreamingService] Error stopping all streams:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  startStream,
  stopStream,
  startAllStreams,
  stopAllStreams,
  isStreamActive,
  getActiveStreams,
  getStreamLogs,
  syncStreamStatuses,
  saveStreamHistory
};
schedulerService.init(module.exports);





