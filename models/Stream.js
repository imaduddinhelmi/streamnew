const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
class Stream {
  static create(streamData) {
    const id = uuidv4();
    const {
      title,
      video_id,
      rtmp_url,
      stream_key,
      platform,
      platform_icon,
      bitrate = 2500,
      resolution,
      fps = 30,
      orientation = 'horizontal',
      loop_video = true,
      schedule_time = null,
      duration = null,
      use_advanced_settings = false,
      auto_daily_live = false,
      daily_start_time = null,
      user_id
    } = streamData;
    const loop_video_int = loop_video ? 1 : 0;
    const use_advanced_settings_int = use_advanced_settings ? 1 : 0;
    const auto_daily_live_int = auto_daily_live ? 1 : 0;
    const status = schedule_time ? 'scheduled' : 'offline';
    const status_updated_at = new Date().toISOString();
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO streams (
          id, title, video_id, rtmp_url, stream_key, platform, platform_icon,
          bitrate, resolution, fps, orientation, loop_video,
          schedule_time, duration, status, status_updated_at, use_advanced_settings, 
          auto_daily_live, daily_start_time, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, title, video_id, rtmp_url, stream_key, platform, platform_icon,
          bitrate, resolution, fps, orientation, loop_video_int,
          schedule_time, duration, status, status_updated_at, use_advanced_settings_int,
          auto_daily_live_int, daily_start_time, user_id
        ],
        function (err) {
          if (err) {
            console.error('Error creating stream:', err.message);
            return reject(err);
          }
          resolve({ id, ...streamData, status, status_updated_at });
        }
      );
    });
  }
  static findById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM streams WHERE id = ?', [id], (err, row) => {
        if (err) {
          console.error('Error finding stream:', err.message);
          return reject(err);
        }
        if (row) {
          row.loop_video = row.loop_video === 1;
          row.use_advanced_settings = row.use_advanced_settings === 1;
          row.auto_daily_live = row.auto_daily_live === 1;
        }
        resolve(row);
      });
    });
  }
  static findAll(userId = null, filter = null) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT s.*, 
               v.title AS video_title, 
               v.filepath AS video_filepath,
               v.thumbnail_path AS video_thumbnail, 
               v.duration AS video_duration,
               v.resolution AS video_resolution,  
               v.bitrate AS video_bitrate,        
               v.fps AS video_fps,
               p.name AS playlist_name,
               CASE 
                 WHEN p.id IS NOT NULL THEN 'playlist'
                 WHEN v.id IS NOT NULL THEN 'video'
                 ELSE NULL
               END AS video_type
        FROM streams s
        LEFT JOIN videos v ON s.video_id = v.id
        LEFT JOIN playlists p ON s.video_id = p.id
      `;
      const params = [];
      if (userId) {
        query += ' WHERE s.user_id = ?';
        params.push(userId);
        if (filter) {
          if (filter === 'live') {
            query += " AND s.status = 'live'";
          } else if (filter === 'scheduled') {
            query += " AND s.status = 'scheduled'";
          } else if (filter === 'offline') {
            query += " AND s.status = 'offline'";
          }
        }
      }
      query += ' ORDER BY s.created_at DESC';
      db.all(query, params, (err, rows) => {
        if (err) {
          console.error('Error finding streams:', err.message);
          return reject(err);
        }
        if (rows) {
          rows.forEach(row => {
            row.loop_video = row.loop_video === 1;
            row.use_advanced_settings = row.use_advanced_settings === 1;
            row.auto_daily_live = row.auto_daily_live === 1;
          });
        }
        resolve(rows || []);
      });
    });
  }
  static update(id, streamData) {
    const fields = [];
    const values = [];
    Object.entries(streamData).forEach(([key, value]) => {
      if ((key === 'loop_video' || key === 'auto_daily_live') && typeof value === 'boolean') {
        fields.push(`${key} = ?`);
        values.push(value ? 1 : 0);
      } else {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    });
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    const query = `UPDATE streams SET ${fields.join(', ')} WHERE id = ?`;
    return new Promise((resolve, reject) => {
      db.run(query, values, function (err) {
        if (err) {
          console.error('Error updating stream:', err.message);
          return reject(err);
        }
        resolve({ id, ...streamData });
      });
    });
  }
  static delete(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM streams WHERE id = ? AND user_id = ?',
        [id, userId],
        function (err) {
          if (err) {
            console.error('Error deleting stream:', err.message);
            return reject(err);
          }
          resolve({ success: true, deleted: this.changes > 0 });
        }
      );
    });
  }
  static updateStatus(id, status, userId = null) {
    const status_updated_at = new Date().toISOString();
    let start_time = null;
    let end_time = null;
    if (status === 'live') {
      start_time = new Date().toISOString();
    } else if (status === 'offline') {
      end_time = new Date().toISOString();
    }
    return new Promise((resolve, reject) => {
      let query, params;
      if (userId) {
        query = `UPDATE streams SET 
          status = ?, 
          status_updated_at = ?, 
          start_time = COALESCE(?, start_time), 
          end_time = COALESCE(?, end_time),
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`;
        params = [status, status_updated_at, start_time, end_time, id, userId];
      } else {
        query = `UPDATE streams SET 
          status = ?, 
          status_updated_at = ?, 
          start_time = COALESCE(?, start_time), 
          end_time = COALESCE(?, end_time),
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`;
        params = [status, status_updated_at, start_time, end_time, id];
      }
      db.run(query, params, function (err) {
        if (err) {
          console.error('Error updating stream status:', err.message);
          return reject(err);
        }
        if (this.changes === 0) {
          console.warn(`[Stream.updateStatus] No rows updated for stream ${id}, status: ${status}, userId: ${userId || 'not provided'}`);
        }
        resolve({
          id,
          status,
          status_updated_at,
          start_time,
          end_time,
          updated: this.changes > 0
        });
      });
    });
  }
  // Update status only without changing start_time or end_time - used for restarts
  static updateStatusOnly(id, status, userId = null) {
    const status_updated_at = new Date().toISOString();
    return new Promise((resolve, reject) => {
      let query, params;
      if (userId) {
        query = `UPDATE streams SET 
          status = ?, 
          status_updated_at = ?, 
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`;
        params = [status, status_updated_at, id, userId];
      } else {
        query = `UPDATE streams SET 
          status = ?, 
          status_updated_at = ?, 
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`;
        params = [status, status_updated_at, id];
      }
      db.run(query, params, function (err) {
        if (err) {
          console.error('Error updating stream status only:', err.message);
          return reject(err);
        }
        if (this.changes === 0) {
          console.warn(`[Stream.updateStatusOnly] No rows updated for stream ${id}, status: ${status}`);
        }
        resolve({
          id,
          status,
          status_updated_at,
          updated: this.changes > 0
        });
      });
    });
  }
  static async getStreamWithVideo(id) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT s.*, 
                v.title AS video_title, 
                v.filepath AS video_filepath, 
                v.thumbnail_path AS video_thumbnail, 
                v.duration AS video_duration,
                p.name AS playlist_name,
                CASE 
                  WHEN p.id IS NOT NULL THEN 'playlist'
                  WHEN v.id IS NOT NULL THEN 'video'
                  ELSE NULL
                END AS video_type
         FROM streams s
         LEFT JOIN videos v ON s.video_id = v.id
         LEFT JOIN playlists p ON s.video_id = p.id
         WHERE s.id = ?`,
        [id],
        (err, row) => {
          if (err) {
            console.error('Error fetching stream with video:', err.message);
            return reject(err);
          }
          if (row) {
            row.loop_video = row.loop_video === 1;
            row.use_advanced_settings = row.use_advanced_settings === 1;
            row.auto_daily_live = row.auto_daily_live === 1;
          }
          resolve(row);
        }
      );
    });
  }
  static async isStreamKeyInUse(streamKey, userId, excludeId = null) {
    return new Promise((resolve, reject) => {
      let query = 'SELECT COUNT(*) as count FROM streams WHERE stream_key = ? AND user_id = ?';
      const params = [streamKey, userId];
      if (excludeId) {
        query += ' AND id != ?';
        params.push(excludeId);
      }
      db.get(query, params, (err, row) => {
        if (err) {
          console.error('Error checking stream key:', err.message);
          return reject(err);
        }
        resolve(row.count > 0);
      });
    });
  }
  static findScheduledInRange(startTime, endTime) {
    return new Promise((resolve, reject) => {
      const startTimeStr = startTime.toISOString();
      const endTimeStr = endTime.toISOString();
      const query = `
        SELECT s.*, 
               v.title AS video_title, 
               v.filepath AS video_filepath,
               v.thumbnail_path AS video_thumbnail, 
               v.duration AS video_duration,
               v.resolution AS video_resolution,
               v.bitrate AS video_bitrate,
               v.fps AS video_fps  
        FROM streams s
        LEFT JOIN videos v ON s.video_id = v.id
        WHERE s.status = 'scheduled'
        AND s.schedule_time IS NOT NULL
        AND s.schedule_time >= ?
        AND s.schedule_time <= ?
      `;
      db.all(query, [startTimeStr, endTimeStr], (err, rows) => {
        if (err) {
          console.error('Error finding scheduled streams:', err.message);
          return reject(err);
        }
        if (rows) {
          rows.forEach(row => {
            row.loop_video = row.loop_video === 1;
            row.use_advanced_settings = row.use_advanced_settings === 1;
            row.auto_daily_live = row.auto_daily_live === 1;
          });
        }
        resolve(rows || []);
      });
    });
  }
  static findAutoDailyLive() {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT s.*, 
               v.title AS video_title, 
               v.filepath AS video_filepath,
               v.thumbnail_path AS video_thumbnail, 
               v.duration AS video_duration,
               v.resolution AS video_resolution,
               v.bitrate AS video_bitrate,
               v.fps AS video_fps  
        FROM streams s
        LEFT JOIN videos v ON s.video_id = v.id
        WHERE s.auto_daily_live = 1
        AND s.daily_start_time IS NOT NULL
      `;
      db.all(query, [], (err, rows) => {
        if (err) {
          console.error('Error finding auto daily live streams:', err.message);
          return reject(err);
        }
        if (rows) {
          rows.forEach(row => {
            row.loop_video = row.loop_video === 1;
            row.use_advanced_settings = row.use_advanced_settings === 1;
            row.auto_daily_live = row.auto_daily_live === 1;
          });
        }
        resolve(rows || []);
      });
    });
  }
}
module.exports = Stream;