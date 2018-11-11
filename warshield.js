const fs = require('fs');
const { EventEmitter } = require('events');
const util = require('util');
const crypto = require('crypto');
const path = require('path');
const { arrayLoop } = require('./helpers');

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const MIN_ROUNDS = 3000;
const MAX_ROUNDS = 9000;

/**
 * @param {string | Buffer | NodeJS.TypedArray | DataView} key 
 * @param {number} rounds 
 * @param {string | Buffer | NodeJS.TypedArray | DataView} salt 
 */
const generateKey = (key, rounds, salt = null) => new Promise((resolve, reject) => {
  salt = salt || crypto.randomBytes(64);

  crypto.pbkdf2(key, salt, rounds, 32, 'sha512', (err, derivedKey) => {
    if (err) return reject(err);

    resolve([derivedKey, salt]);
  });
});

/**
 * @param {string | Buffer | NodeJS.TypedArray | DataView} key 
 */
const encryptStream = (key) => {
  const iv = crypto.randomBytes(16);
  const stream = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  return {
    iv,
    stream,
  };
}

/**
 * @param {string | Buffer | NodeJS.TypedArray | DataView} key 
 * @param {string | Buffer | NodeJS.TypedArray | DataView} iv 
 */
const decryptStream = (key, iv) => {
  return crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
}

/**
 * @param {string} file 
 * @param {string | Buffer | NodeJS.TypedArray | DataView} key 
 */
function encryptFile(file, key) {
  return new Promise(async (resolve, reject) => {
    // Generate warshield file id
    const id = crypto.randomBytes(8).toString('hex');
    const targetpath = `${file}.${id}.warshield`;

    // Error function
    const ERROR = err => {
      fs.unlink(targetpath, () => { });
      reject(err);
    }

    const rounds = Math.floor(Math.random() * (MAX_ROUNDS - MIN_ROUNDS) + MIN_ROUNDS);
    const [derivedKey, salt] = await generateKey(key, rounds);

    // Create cipher stream
    const cipher = encryptStream(derivedKey);
    cipher.stream.on('error', ERROR);

    const source_rs = fs.createReadStream(file).on('error', ERROR);
    const target_ws = fs.createWriteStream(targetpath).on('error', ERROR);

    if (!source_rs.readable || !target_ws.writable) {
      return reject(false);
    }

    // Pipe original file into cipher and cipher into warshield file
    const stream = source_rs.pipe(cipher.stream).pipe(target_ws);

    stream.on('finish', () => {
      cipher.stream.end();
      source_rs.close();
      target_ws.close();

      const target_rs = fs.createReadStream(targetpath).on('error', ERROR);
      const source_ws = fs.createWriteStream(file).on('error', ERROR);

      const tag = cipher.stream.getAuthTag();

      source_ws.write(salt);
      source_ws.write(cipher.iv);
      source_ws.write(tag);
      source_ws.write(Buffer.from(String(rounds)));

      // Pipe warshield file into original file
      target_rs.pipe(source_ws).on('finish', () => {
        target_rs.close();
        source_ws.close();

        fs.unlink(targetpath, () => resolve(true));
      });
    });
  });
}

/**
 * @param {string} file 
 * @param {string | Buffer | NodeJS.TypedArray | DataView} key 
 */
function decryptFile(file, key) {
  return new Promise((resolve, reject) => {
    // Generate warshield file id
    const id = crypto.randomBytes(8).toString('hex');
    const targetpath = `${file}.${id}.warshield`;

    // Error function
    const ERROR = err => {
      fs.unlink(targetpath, () => { });
      reject(err);
    }

    const source_rs = fs.createReadStream(file, { end: 100 }).on('error', ERROR);

    if (!source_rs.readable) {
      return reject(false);
    }

    source_rs.on('open', async fd => {
      try {
        const read = util.promisify(fs.read);

        const { buffer: bufs } = await read(fd, Buffer.alloc(100), 0, 100, 0);
        const salt = bufs.slice(0, 64);
        const iv = bufs.slice(64, 80);
        const tag = bufs.slice(80, 96);
        const rounds = bufs.slice(96, 100);

        source_rs.close();

        const [derivedKey] = await generateKey(key, parseInt(rounds), salt);

        // Create cipher stream
        const decipher = decryptStream(derivedKey, iv).on('error', ERROR);
        decipher.setAuthTag(tag);

        const data_rs = fs.createReadStream(file, { start: 100 }).on('error', ERROR);
        const target_ws = fs.createWriteStream(targetpath).on('error', ERROR);

        if (!data_rs.readable || !target_ws.writable) {
          return reject(false);
        }

        // Pipe original file into cipher and cipher into warshield file
        const stream = data_rs.pipe(decipher).pipe(target_ws);

        stream.on('finish', () => {
          decipher.end();
          data_rs.close();
          target_ws.close();

          const target_rs = fs.createReadStream(targetpath).on('error', ERROR);
          const source_ws = fs.createWriteStream(file).on('error', ERROR);

          // Pipe warshield file into original file
          target_rs.pipe(source_ws).on('finish', () => {
            target_rs.close();
            source_ws.close();

            fs.unlink(targetpath, () => resolve(true));
          });
        });
      } catch (e) {
        ERROR(e);
      }
    });
  });
}

function encryptRecursive(file, key) {
  const em = new EventEmitter();

  (async () => {
    try {
      const stat = await util.promisify(fs.stat)(file);

      const files = [];

      if (stat.isDirectory()) {
        getFiles(file)
          .on('found', file => files.push(file))
          .on('failed', file => em.emit('failed', file))
          .on('end', () => {
            const loop = arrayLoop(files, file => {
              return encryptFile(file, key)
                .then(() => em.emit('done', file))
                .catch(() => em.emit('failed', file));
            });

            let done = 0;

            const end = () => {
              if (++done >= files.length) {
                em.emit('end');
              }
            }

            const next = () => {
              const wait = loop.next();

              if (wait.value) {
                wait.value.finally(() => {
                  next();
                  end();
                });
              }
            }

            for (let i = 0; i < 5; i++) {
              next();
            }
          });
      } else {
        encryptFile(file, key)
          .then(() => em.emit('done', file))
          .catch(() => em.emit('failed', file))
          .finally(() => em.emit('end'));
      }
    } catch (e) {
      console.error(e.message);
    }
  })();

  return em;
}

function decryptRecursive(file, key) {
  const em = new EventEmitter();

  (async () => {
    try {
      const stat = await util.promisify(fs.stat)(file);

      const files = [];

      if (stat.isDirectory()) {
        getFiles(file)
          .on('found', file => files.push(file))
          .on('failed', file => em.emit('failed', file))
          .on('end', () => {
            let done = 0;

            const loop = arrayLoop(files, file => {
              return decryptFile(file, key)
                .then(() => em.emit('done', file))
                .catch(() => em.emit('failed', file));
            });

            const end = () => {
              if (++done >= files.length) {
                em.emit('end');
              }
            }

            const next = () => {
              const wait = loop.next();

              if (wait.value) {
                wait.value.finally(() => {
                  next();
                  end();
                });
              }
            }

            for (let i = 0; i < 5; i++) {
              next();
            }
          });
      } else {
        decryptFile(file, key)
          .then(() => em.emit('done', file))
          .catch(() => em.emit('failed', file))
          .finally(() => em.emit('end'));
      }
    } catch (e) {
      console.error(e.message);
    }
  })();

  return em;
}

/**
 * @param {string} directory 
 */
function getFiles(directory, master = true) {
  const em = new EventEmitter();

  fs.readdir(directory, (err, files) => {
    if (err) {
      em.emit('failed', directory);
      return em.emit('end');
    }

    let done = 0;

    function end() {
      if (++done >= files.length) {
        em.emit('end');
      }
    }

    if (files.length === 0) {
      end();
    }

    for (let i in files) {
      const filepath = path.join(directory, files[i]);

      fs.stat(filepath, (err, stat) => {
        if (err) {
          em.emit('failed', filepath);
          return end();
        }

        if (stat.isDirectory()) {
          getFiles(filepath, false)
            .on('failed', file => em.emit('failed', file))
            .on('found', file => em.emit('found', file))
            .on('end', () => {

              end();
            });
        } else {
          em.emit('found', filepath);
          end();
        }
      });
    }
  });

  return em;
}

module.exports = {
  generateKey,
  encryptStream,
  decryptStream,
  encryptFile,
  decryptFile,
  encryptRecursive,
  decryptRecursive,
}