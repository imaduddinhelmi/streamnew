const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { paths, getUniqueFilename } = require('./storage');

function extractFileId(driveUrl) {
  let match = driveUrl.match(/\/file\/d\/([^\/]+)/);
  if (match) return match[1];

  match = driveUrl.match(/\?id=([^&]+)/);
  if (match) return match[1];

  match = driveUrl.match(/\/d\/([^\/]+)/);
  if (match) return match[1];

  if (/^[a-zA-Z0-9_-]{25,}$/.test(driveUrl.trim())) {
    return driveUrl.trim();
  }

  throw new Error('Invalid Google Drive URL format');
}

async function downloadFile(fileId, progressCallback = null) {
  try {
    const tempFilename = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const tempPath = path.join(paths.videos, tempFilename);
    
    console.log(`[GoogleDrive] Starting download for file ID: ${fileId}`);
    
    // Try multiple methods to download
    // Method 1: Direct download with uc endpoint
    const urls = [
      `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`,
      `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`,
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=AIzaSyC1qbk75NzWjZfPI5BXVcTx4xGNjXyxXXY`
    ];
    
    let response = null;
    let lastError = null;
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`[GoogleDrive] Attempting download method ${i + 1}: ${url.includes('googleapis') ? 'Google Drive API' : 'Direct download'}`);
      
      try {
        response = await axios.get(url, {
          responseType: 'stream',
          maxRedirects: 10,
          validateStatus: (status) => status < 500, // Accept redirects and client errors for now
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://drive.google.com/'
          },
          timeout: 30000
        });
        
        const contentType = response.headers['content-type'] || '';
        const contentLength = parseInt(response.headers['content-length'] || '0');
        
        console.log(`[GoogleDrive] Response status: ${response.status}`);
        console.log(`[GoogleDrive] Content-Type: ${contentType}`);
        console.log(`[GoogleDrive] Content-Length: ${contentLength}`);
        
        // If we got a good response with video content, break
        if (response.status === 200 && (contentType.includes('video') || contentType.includes('octet-stream') || contentLength > 100000)) {
          console.log(`[GoogleDrive] Success with method ${i + 1}`);
          break;
        }
        
        // If HTML response, check if it's an error or confirmation page
        if (contentType.includes('text/html')) {
          let html = '';
          const chunks = [];
          
          response.data.on('data', chunk => {
            chunks.push(chunk);
          });
          
          await new Promise((resolve, reject) => {
            response.data.on('end', resolve);
            response.data.on('error', reject);
          });
          
          html = Buffer.concat(chunks).toString('utf-8');
          
          // Check for specific error messages
          if (html.includes('Google Drive - Access denied') || html.includes('you need permission')) {
            throw new Error('ACCESS_DENIED');
          }
          
          if (html.includes('Google Drive - File not found') || html.includes('we\'re sorry') || html.includes('cannot be found')) {
            throw new Error('FILE_NOT_FOUND');
          }
          
          // Check for download confirmation page (large files)
          const confirmMatch = html.match(/href="([^"]*\/uc\?[^"]*export=download[^"]*)"/);
          const downloadIdMatch = html.match(/id="downloadForm"[^>]*action="([^"]*)"/);
          const uuidMatch = html.match(/name="uuid"\s+value="([^"]*)"/);
          
          if (confirmMatch || downloadIdMatch) {
            let confirmUrl = confirmMatch ? confirmMatch[1] : downloadIdMatch[1];
            confirmUrl = confirmUrl.replace(/&amp;/g, '&');
            
            if (!confirmUrl.startsWith('http')) {
              confirmUrl = `https://drive.google.com${confirmUrl}`;
            }
            
            if (uuidMatch) {
              confirmUrl += `&uuid=${uuidMatch[1]}`;
            }
            
            console.log(`[GoogleDrive] Found download confirmation, trying: ${confirmUrl}`);
            
            response = await axios.get(confirmUrl, {
              responseType: 'stream',
              maxRedirects: 10,
              validateStatus: (status) => status < 500,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*',
                'Referer': 'https://drive.google.com/'
              }
            });
            
            const newContentType = response.headers['content-type'] || '';
            if (response.status === 200 && (newContentType.includes('video') || newContentType.includes('octet-stream'))) {
              console.log('[GoogleDrive] Confirmation download successful');
              break;
            }
          }
          
          // If still HTML and we have more methods, try next
          if (i < urls.length - 1) {
            console.log(`[GoogleDrive] Method ${i + 1} returned HTML, trying next method...`);
            continue;
          }
        }
        
        // If we got here with method that worked, break
        if (response.status === 200) {
          break;
        }
        
      } catch (error) {
        console.log(`[GoogleDrive] Method ${i + 1} failed: ${error.message}`);
        lastError = error;
        
        if (error.message === 'ACCESS_DENIED') {
          throw new Error('Access denied. File must be shared with "Anyone with the link" permission in Google Drive. Go to file > Share > General access > Anyone with the link.');
        }
        
        if (error.message === 'FILE_NOT_FOUND') {
          throw new Error('File not found. Please check if the file ID is correct and the file still exists in Google Drive.');
        }
        
        // Try next method
        if (i < urls.length - 1) {
          continue;
        }
      }
    }
    
    // If no method worked
    if (!response || response.status !== 200) {
      console.log('[GoogleDrive] All download methods failed');
      throw new Error('Unable to download file from Google Drive. Please ensure: 1) File is shared with "Anyone with the link", 2) File exists and is not deleted, 3) You have copied the full file ID or URL correctly.');
    }

    const totalSize = parseInt(response.headers['content-length'] || '0');
    let downloadedSize = 0;
    let lastProgress = 0;

    // Create write stream
    const writer = fs.createWriteStream(tempPath);

    // Track progress
    response.data.on('data', (chunk) => {
      downloadedSize += chunk.length;
      
      if (totalSize > 0 && progressCallback) {
        const progress = Math.round((downloadedSize / totalSize) * 100);
        if (progress > lastProgress && progress <= 100) {
          lastProgress = progress;
          progressCallback({
            id: fileId,
            filename: 'Google Drive File',
            progress: progress
          });
        }
      }
    });

    // Pipe to file
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        try {
          if (!fs.existsSync(tempPath)) {
            return reject(new Error('Download failed: File not created'));
          }

          const stats = fs.statSync(tempPath);
          const fileSize = stats.size;
          
          if (fileSize < 1000) {
            // File too small, might be an error page
            const content = fs.readFileSync(tempPath, 'utf8');
            fs.unlinkSync(tempPath);
            
            console.log(`[GoogleDrive] Downloaded file is too small (${fileSize} bytes), checking content...`);
            
            if (content.includes('Google Drive') && content.includes('quota')) {
              return reject(new Error('Download quota exceeded. Please try again later.'));
            }
            if (content.includes('Access denied') || content.includes('403')) {
              return reject(new Error('Access denied. File must be shared with "Anyone with the link" permission in Google Drive.'));
            }
            if (content.includes('404') || content.includes('Not Found')) {
              return reject(new Error('File not found. Please check if the file ID or URL is correct.'));
            }
            
            console.log(`[GoogleDrive] Response content preview: ${content.substring(0, 200)}`);
            return reject(new Error('Failed to download file. Please make sure the file is shared with "Anyone with the link" permission in Google Drive (right-click file > Share > General access > Anyone with the link).'));
          }

          const originalFilename = `gdrive_${fileId}.mp4`;
          const uniqueFilename = getUniqueFilename(originalFilename);
          const finalPath = path.join(paths.videos, uniqueFilename);
          
          fs.renameSync(tempPath, finalPath);
          
          console.log(`[GoogleDrive] Downloaded file successfully: ${uniqueFilename} (${fileSize} bytes)`);
          
          resolve({
            filename: uniqueFilename,
            originalFilename: originalFilename,
            localFilePath: finalPath,
            mimeType: 'video/mp4',
            fileSize: fileSize
          });
        } catch (error) {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
          reject(new Error(`Error processing downloaded file: ${error.message}`));
        }
      });

      writer.on('error', (error) => {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
        reject(new Error(`Error writing file: ${error.message}`));
      });

      response.data.on('error', (error) => {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
        reject(new Error(`Error downloading file: ${error.message}`));
      });
    });
  } catch (error) {
    console.error('[GoogleDrive] Error downloading file:', error.message);
    
    if (error.response) {
      if (error.response.status === 404) {
        throw new Error('File not found. Please check the Google Drive URL or file ID.');
      } else if (error.response.status === 403) {
        throw new Error('Access denied. Please make sure the file is publicly accessible.');
      }
    }
    
    throw new Error(`Failed to download from Google Drive: ${error.message}`);
  }
}

module.exports = {
  extractFileId,
  downloadFile
};
