# Deploy dashboard (requires cloudwatch:PutDashboard)
aws cloudwatch put-dashboard 
  --dashboard-name Anot-RDS-Performance 
  --dashboard-body file://dist/cloudwatch-rds-performance-dashboard.json 
  --region ap-southeast-1