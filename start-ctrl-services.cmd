@echo off
start "autoburner" cmd /k "cd /d ""c:\Users\Lenovo Ideapad Slim\Desktop\ctrl\autoburner"" && set UI_PORT=8790 && npm start"
start "ctrl-dashboard" cmd /k "cd /d ""c:\Users\Lenovo Ideapad Slim\Desktop\ctrl\ctrl-burn-dashboard-main\ctrl-burn-dashboard-main"" && set CTRL_WORKER_EVENTS_URL=http://127.0.0.1:8790/events && set CTRL_WORKER_STATUS_URL=http://127.0.0.1:8790/status && npm run dev"
