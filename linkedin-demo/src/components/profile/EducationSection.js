import React from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  TextField,
  Typography,
} from "@material-ui/core";
import { fade, useTheme } from "@material-ui/core/styles";

const formatEducationDateRange = (startYear, endYear) => {
  const hasStartYear = typeof startYear === "string" && startYear.trim().length > 0;
  const hasEndYear = typeof endYear === "string" && endYear.trim().length > 0;

  if (hasStartYear && hasEndYear) {
    return `${startYear} - ${endYear}`;
  }

  if (hasStartYear) {
    return `${startYear} - Present`;
  }

  return "";
};

const EducationSection = ({
  isOwnProfile,
  educationEntries,
  isEducationSavePending,
  isEducationDialogOpen,
  editingEducationId,
  educationFormData,
  primaryColor,
  onOpenCreateDialog,
  onOpenEditDialog,
  onRemoveEducation,
  onCloseDialog,
  onSaveEducation,
  onEducationFieldChange,
}) => {
  const theme = useTheme();

  return (
    <>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        marginBottom: 6,
      }}
    >
      <Typography variant="subtitle2" style={{ fontWeight: 700 }}>
        Education
      </Typography>
      {isOwnProfile && (
        <Button
          size="small"
          variant="text"
          onClick={onOpenCreateDialog}
          style={{
            textTransform: "none",
            color: primaryColor,
            fontWeight: 600,
            minHeight: 32,
          }}
        >
          Add education
        </Button>
      )}
    </div>

    {educationEntries.length === 0 && (
      <Typography variant="body2" color="textSecondary">
        No education added yet.
      </Typography>
    )}

    {educationEntries.map((entry) => {
      const dateRange = formatEducationDateRange(entry.startYear, entry.endYear);
      return (
        <div
          key={entry.id}
          style={{
            border: `1px solid ${fade(theme.palette.primary.main, 0.2)}`,
            borderRadius: 10,
            padding: "10px 12px",
            marginBottom: 10,
          }}
        >
          <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 2 }}>
            {entry.school}
          </Typography>
          <Typography
            variant="body2"
            color="textSecondary"
            style={{ fontWeight: 600, marginBottom: 2 }}
          >
            {[entry.degree, entry.field].filter(Boolean).join(", ")}
          </Typography>
          {dateRange && (
            <Typography
              variant="body2"
              color="textSecondary"
              style={{ fontSize: "0.8rem", marginBottom: isOwnProfile ? 6 : 2 }}
            >
              {dateRange}
            </Typography>
          )}
          {isOwnProfile && (
            <div style={{ display: "flex", gap: 6 }}>
              <Button
                size="small"
                variant="outlined"
                onClick={() => onOpenEditDialog(entry)}
                disabled={isEducationSavePending}
                style={{
                  textTransform: "none",
                  borderRadius: 16,
                  borderColor: primaryColor,
                  color: primaryColor,
                  fontWeight: 600,
                  padding: "2px 10px",
                }}
              >
                Edit
              </Button>
              <Button
                size="small"
                variant="outlined"
                onClick={() => onRemoveEducation(entry.id)}
                disabled={isEducationSavePending}
                style={{
                  textTransform: "none",
                  borderRadius: 16,
                  borderColor: "#c62828",
                  color: "#c62828",
                  fontWeight: 600,
                  padding: "2px 10px",
                }}
              >
                Delete
              </Button>
            </div>
          )}
        </div>
      );
    })}

    <Divider style={{ margin: "16px 0 12px" }} />

    <Dialog
      open={isEducationDialogOpen}
      onClose={() => onCloseDialog()}
      fullWidth
      maxWidth="sm"
      aria-labelledby="education-dialog-title"
    >
      <DialogTitle id="education-dialog-title">
        {editingEducationId ? "Edit education" : "Add education"}
      </DialogTitle>
      <DialogContent dividers>
        <TextField
          label="School"
          value={educationFormData.school}
          onChange={onEducationFieldChange("school")}
          variant="outlined"
          margin="dense"
          fullWidth
          required
        />
        <TextField
          label="Degree"
          value={educationFormData.degree}
          onChange={onEducationFieldChange("degree")}
          variant="outlined"
          margin="dense"
          fullWidth
          required
        />
        <TextField
          label="Field of study"
          value={educationFormData.field}
          onChange={onEducationFieldChange("field")}
          variant="outlined"
          margin="dense"
          fullWidth
          required
        />
        <TextField
          label="Start year"
          placeholder="e.g. 2018"
          value={educationFormData.startYear}
          onChange={onEducationFieldChange("startYear")}
          variant="outlined"
          margin="dense"
          fullWidth
          required
        />
        <TextField
          label="End year"
          placeholder="e.g. 2022 or Present"
          value={educationFormData.endYear}
          onChange={onEducationFieldChange("endYear")}
          variant="outlined"
          margin="dense"
          fullWidth
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onCloseDialog()} disabled={isEducationSavePending}>
          Cancel
        </Button>
        <Button
          onClick={onSaveEducation}
          variant="contained"
          color="primary"
          disabled={isEducationSavePending}
        >
          {editingEducationId ? "Update" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
    </>
  );
};

export default EducationSection;
