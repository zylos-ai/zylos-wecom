const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-wecom',
    script: 'src/index.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/wecom'),
    env: {
      NODE_ENV: 'production'
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    error_file: path.join(os.homedir(), 'zylos/components/wecom/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/wecom/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
