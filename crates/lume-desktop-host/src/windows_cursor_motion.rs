use std::f64::consts::PI;

const DEFAULT_START_HANDLE: f64 = 0.29;
const DEFAULT_END_HANDLE: f64 = 0.08;
const DEFAULT_ARC_SIZE: f64 = 0.06;
const DEFAULT_ARC_FLOW: f64 = 0.64;
const NORMALIZATION_EPSILON: f64 = 0.001;
const SPRING_RESPONSE: f64 = 1.4;
const SPRING_DAMPING: f64 = 0.9;
const SPRING_DT: f64 = 1.0 / 240.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorPoint {
    pub x: f64,
    pub y: f64,
}

impl CursorPoint {
    fn translated(self, vector: CursorVector) -> Self {
        Self {
            x: self.x + vector.x,
            y: self.y + vector.y,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorVector {
    pub x: f64,
    pub y: f64,
}

impl CursorVector {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn between(start: CursorPoint, end: CursorPoint) -> Self {
        Self {
            x: end.x - start.x,
            y: end.y - start.y,
        }
    }

    pub fn length(self) -> f64 {
        self.x.hypot(self.y)
    }

    pub fn normalized(self) -> Self {
        let length = self.length().max(NORMALIZATION_EPSILON);
        Self::new(self.x / length, self.y / length)
    }

    pub fn scaled(self, scale: f64) -> Self {
        Self::new(self.x * scale, self.y * scale)
    }

    fn added(self, other: Self) -> Self {
        Self::new(self.x + other.x, self.y + other.y)
    }

    fn perpendicular(self) -> Self {
        Self::new(-self.y, self.x)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl CursorBounds {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    fn contains(self, point: CursorPoint, padding: f64) -> bool {
        point.x >= self.x - padding
            && point.x <= self.x + self.width + padding
            && point.y >= self.y - padding
            && point.y <= self.y + self.height + padding
    }
}

#[derive(Clone, Copy)]
struct CubicPath {
    start: CursorPoint,
    control1: CursorPoint,
    control2: CursorPoint,
    end: CursorPoint,
}

impl CubicPath {
    fn point(self, progress: f64) -> CursorPoint {
        let t = progress.clamp(0.0, 1.0);
        if t == 0.0 {
            return self.start;
        }
        if t == 1.0 {
            return self.end;
        }
        let inverse = 1.0 - t;
        let a = inverse.powi(3);
        let b = 3.0 * inverse.powi(2) * t;
        let c = 3.0 * inverse * t.powi(2);
        let d = t.powi(3);
        CursorPoint {
            x: a * self.start.x + b * self.control1.x + c * self.control2.x + d * self.end.x,
            y: a * self.start.y + b * self.control1.y + c * self.control2.y + d * self.end.y,
        }
    }

    fn tangent(self, progress: f64) -> CursorVector {
        let t = progress.clamp(0.0, 1.0);
        let inverse = 1.0 - t;
        CursorVector::new(
            3.0 * inverse.powi(2) * (self.control1.x - self.start.x)
                + 6.0 * inverse * t * (self.control2.x - self.control1.x)
                + 3.0 * t.powi(2) * (self.end.x - self.control2.x),
            3.0 * inverse.powi(2) * (self.control1.y - self.start.y)
                + 6.0 * inverse * t * (self.control2.y - self.control1.y)
                + 3.0 * t.powi(2) * (self.end.y - self.control2.y),
        )
        .normalized()
    }

    fn measure(self, bounds: CursorBounds) -> Measurement {
        let mut length = 0.0;
        let mut angle_change_energy = 0.0;
        let mut max_angle_change: f64 = 0.0;
        let mut total_turn = 0.0;
        let mut stays_in_bounds = bounds.contains(self.start, 20.0);
        let mut previous_point = self.start;
        let mut previous_angle: Option<f64> = None;

        for step in 1..=24 {
            let point = self.point(f64::from(step) / 24.0);
            let delta = CursorVector::between(previous_point, point);
            let step_length = delta.length();
            if stays_in_bounds {
                stays_in_bounds = bounds.contains(point, 20.0);
            }
            if step_length <= 0.01 {
                continue;
            }
            let angle = delta.y.atan2(delta.x);
            length += step_length;
            if let Some(previous) = previous_angle {
                let angle_delta = normalize_angle(angle - previous);
                angle_change_energy += angle_delta * angle_delta;
                max_angle_change = max_angle_change.max(angle_delta.abs());
                total_turn += angle_delta.abs();
            }
            previous_angle = Some(angle);
            previous_point = point;
        }

        Measurement {
            length,
            angle_change_energy,
            max_angle_change,
            total_turn,
            stays_in_bounds,
        }
    }
}

#[derive(Clone, Copy)]
struct Measurement {
    length: f64,
    angle_change_energy: f64,
    max_angle_change: f64,
    total_turn: f64,
    stays_in_bounds: bool,
}

#[derive(Clone, Copy)]
struct Descriptor {
    id: &'static str,
    family: &'static str,
    side: i32,
    start_reach_scale: f64,
    end_reach_scale: f64,
    start_line_weight: f64,
    end_line_weight: f64,
    start_heading_weight: f64,
    end_heading_weight: f64,
    start_normal_scale: f64,
    end_normal_scale: f64,
    start_guide_normal_bias: f64,
    end_guide_normal_bias: f64,
    start_flow_weight: f64,
    end_flow_weight: f64,
    flow_shift: f64,
    arc_scale: f64,
    score_bias: f64,
}

#[derive(Clone, Copy)]
struct Candidate {
    descriptor: Descriptor,
    path: CubicPath,
    measurement: Measurement,
    score: f64,
}

#[derive(Clone, Copy)]
struct MotionMetrics {
    dx: f64,
    dy: f64,
    distance: f64,
    direction: CursorVector,
    normal: CursorVector,
    far_factor: f64,
}

impl MotionMetrics {
    fn new(start: CursorPoint, end: CursorPoint) -> Self {
        let delta = CursorVector::between(start, end);
        let distance = delta.length().max(1.0);
        let direction = delta.normalized();
        Self {
            dx: delta.x,
            dy: delta.y,
            distance,
            direction,
            normal: direction.perpendicular().normalized(),
            far_factor: ((distance - 180.0) / 540.0).clamp(0.0, 1.0),
        }
    }
}

#[derive(Clone, Copy)]
pub struct CursorMotion {
    path: CubicPath,
    measurement: Measurement,
    side: i32,
}

impl CursorMotion {
    pub fn new(
        start: CursorPoint,
        end: CursorPoint,
        bounds: CursorBounds,
        start_forward: CursorVector,
        end_forward: CursorVector,
    ) -> Self {
        let metrics = MotionMetrics::new(start, end);
        let start_forward = start_forward.normalized();
        let end_forward = end_forward.normalized();
        let preferred_side = preferred_turn_side(metrics, start_forward, end_forward);
        let candidates = descriptors(metrics, preferred_side)
            .into_iter()
            .map(|descriptor| {
                let path = make_path(start, end, metrics, descriptor, start_forward, end_forward);
                let measurement = path.measure(bounds);
                let score = score_candidate(
                    measurement,
                    path,
                    descriptor,
                    metrics,
                    start_forward,
                    end_forward,
                    preferred_side,
                );
                Candidate {
                    descriptor,
                    path,
                    measurement,
                    score,
                }
            })
            .collect::<Vec<_>>();
        let pool = if candidates
            .iter()
            .any(|candidate| candidate.measurement.stays_in_bounds)
        {
            candidates
                .iter()
                .filter(|candidate| candidate.measurement.stays_in_bounds)
                .collect::<Vec<_>>()
        } else {
            candidates.iter().collect::<Vec<_>>()
        };
        let chosen = pool
            .into_iter()
            .min_by(|left, right| {
                left.score
                    .total_cmp(&right.score)
                    .then_with(|| left.descriptor.id.cmp(right.descriptor.id))
            })
            .expect("cursor motion always has candidates");
        Self {
            path: chosen.path,
            measurement: chosen.measurement,
            side: chosen.descriptor.side,
        }
    }

    pub fn point_at_elapsed(self, elapsed_seconds: f64) -> CursorPoint {
        if elapsed_seconds <= 0.0 {
            return self.path.start;
        }
        if elapsed_seconds >= spring_close_enough_time_seconds() {
            return self.path.end;
        }
        self.path.point(spring_progress_at(elapsed_seconds))
    }

    pub fn tangent_at_elapsed(self, elapsed_seconds: f64) -> CursorVector {
        self.path.tangent(spring_progress_at(elapsed_seconds))
    }

    pub fn side(self) -> i32 {
        self.side
    }

    pub fn total_turn(self) -> f64 {
        self.measurement.total_turn
    }

    pub fn path_length(self) -> f64 {
        self.measurement.length
    }
}

fn make_path(
    start: CursorPoint,
    end: CursorPoint,
    metrics: MotionMetrics,
    descriptor: Descriptor,
    start_forward: CursorVector,
    end_forward: CursorVector,
) -> CubicPath {
    let resolved_flow = (DEFAULT_ARC_FLOW + descriptor.flow_shift).clamp(0.0, 1.0);
    let flow_bias = (resolved_flow - 0.5) * metrics.distance * 0.18;
    let base_start_reach = metrics.distance * (0.10 + DEFAULT_START_HANDLE * 0.56);
    let base_end_reach = metrics.distance * (0.11 + DEFAULT_END_HANDLE * 0.62);
    let distance_lift = 0.68 + metrics.far_factor * 0.56;
    let base_arc_height = (metrics.distance
        * (0.10 + DEFAULT_ARC_SIZE * 0.92)
        * descriptor.arc_scale
        * distance_lift)
        .max(20.0)
        .min(metrics.distance * 0.96);
    let side_sign = f64::from(descriptor.side);
    let arc_vector = metrics.normal.scaled(base_arc_height * side_sign);
    let start_guide = resolved_guide(
        metrics.direction,
        start_forward,
        metrics.normal,
        side_sign,
        descriptor.start_line_weight,
        descriptor.start_heading_weight,
        descriptor.start_guide_normal_bias,
    );
    let end_guide = resolved_guide(
        metrics.direction,
        end_forward,
        metrics.normal,
        side_sign,
        descriptor.end_line_weight,
        descriptor.end_heading_weight,
        descriptor.end_guide_normal_bias,
    );
    let start_reach = (base_start_reach * descriptor.start_reach_scale
        + flow_bias * descriptor.start_flow_weight)
        .max(12.0);
    let end_reach = (base_end_reach * descriptor.end_reach_scale
        - flow_bias * descriptor.end_flow_weight)
        .max(12.0);
    CubicPath {
        start,
        control1: start
            .translated(start_guide.scaled(start_reach))
            .translated(arc_vector.scaled(descriptor.start_normal_scale)),
        control2: end
            .translated(end_guide.scaled(-end_reach))
            .translated(arc_vector.scaled(descriptor.end_normal_scale)),
        end,
    }
}

#[allow(clippy::too_many_arguments)]
fn score_candidate(
    measurement: Measurement,
    path: CubicPath,
    descriptor: Descriptor,
    metrics: MotionMetrics,
    start_forward: CursorVector,
    end_forward: CursorVector,
    preferred_side: i32,
) -> f64 {
    let excess_length_ratio = (measurement.length / metrics.distance - 1.0).max(0.0);
    let start_heading_error = signed_angle(start_forward, path.tangent(0.04)).abs();
    let end_heading_error = signed_angle(path.tangent(0.96), end_forward).abs();
    let turn_demand = (signed_angle(start_forward, metrics.direction).abs() / PI).min(1.0);
    let arrival_demand = (signed_angle(metrics.direction, end_forward).abs() / PI).min(1.0);
    let directness = (1.0 - turn_demand.max(arrival_demand * 0.82)).clamp(0.0, 1.0);
    let mut score = descriptor.score_bias
        + excess_length_ratio * 180.0
        + measurement.angle_change_energy * 90.0
        + measurement.max_angle_change * 85.0
        + measurement.total_turn * if descriptor.side == 0 { 10.0 } else { 12.0 }
        + start_heading_error * 150.0
        + end_heading_error * 120.0;
    if descriptor.side == 0 {
        score += turn_demand * 130.0 + arrival_demand * 30.0;
    } else {
        score += directness * 90.0;
        if descriptor.side != preferred_side {
            score += turn_demand.max(0.45) * 200.0;
        }
    }
    score += match descriptor.family {
        "turn" => (1.0 - turn_demand) * 55.0,
        "brake" => (1.0 - arrival_demand) * 40.0,
        "orbit" => directness * 70.0,
        "direct" => (turn_demand - 0.12).max(0.0) * 80.0,
        _ => 0.0,
    };
    if !measurement.stays_in_bounds {
        score += 90.0;
    }
    score
}

fn descriptors(metrics: MotionMetrics, preferred_side: i32) -> [Descriptor; 10] {
    let orbit_scale = 0.82 + metrics.far_factor * 0.26;
    let turnaround_scale = 0.90 + metrics.far_factor * 0.30;
    let braking_scale = 0.74 + metrics.far_factor * 0.24;
    [
        descriptor(
            "direct-tight",
            "direct",
            0,
            0.90,
            0.86,
            1.12,
            1.04,
            0.18,
            0.20,
            0.02,
            0.02,
            0.0,
            0.0,
            0.02,
            0.02,
            -0.02,
            0.16,
            18.0,
        ),
        descriptor(
            "direct-soft",
            "direct",
            0,
            0.98,
            0.94,
            1.04,
            0.96,
            0.22,
            0.28,
            0.04,
            0.08,
            0.0,
            0.04,
            0.04,
            0.08,
            0.02,
            0.24,
            24.0,
        ),
        descriptor(
            "turn-primary-tight",
            "turn",
            preferred_side,
            1.26,
            1.30,
            -0.24,
            -0.04,
            1.50,
            1.18,
            0.46,
            0.08,
            0.30,
            0.16,
            -0.30,
            0.20,
            -0.08,
            turnaround_scale,
            40.0,
        ),
        descriptor(
            "turn-primary-wide",
            "turn",
            preferred_side,
            1.30,
            1.36,
            -0.28,
            -0.10,
            1.54,
            1.24,
            0.58,
            0.12,
            0.34,
            0.20,
            -0.34,
            0.24,
            0.06,
            turnaround_scale * 1.06,
            46.0,
        ),
        descriptor(
            "brake-primary-tight",
            "brake",
            preferred_side,
            0.92,
            1.42,
            0.50,
            -0.20,
            0.70,
            1.52,
            0.16,
            0.20,
            0.10,
            0.26,
            0.10,
            0.32,
            -0.04,
            braking_scale,
            44.0,
        ),
        descriptor(
            "brake-primary-wide",
            "brake",
            preferred_side,
            0.98,
            1.50,
            0.44,
            -0.26,
            0.74,
            1.62,
            0.22,
            0.26,
            0.12,
            0.32,
            0.14,
            0.38,
            0.04,
            braking_scale * 1.04,
            50.0,
        ),
        descriptor(
            "orbit-primary-tight",
            "orbit",
            preferred_side,
            0.90,
            0.98,
            0.72,
            0.76,
            0.30,
            0.22,
            0.90,
            0.82,
            0.16,
            0.06,
            0.26,
            0.12,
            -0.06,
            orbit_scale,
            54.0,
        ),
        descriptor(
            "orbit-primary-wide",
            "orbit",
            preferred_side,
            0.94,
            1.02,
            0.68,
            0.82,
            0.28,
            0.22,
            1.02,
            0.94,
            0.18,
            0.08,
            0.30,
            0.16,
            0.06,
            orbit_scale * 1.06,
            60.0,
        ),
        descriptor(
            "turn-secondary",
            "turn",
            -preferred_side,
            1.18,
            1.26,
            -0.18,
            0.02,
            1.32,
            1.08,
            0.34,
            0.06,
            0.22,
            0.14,
            -0.20,
            0.14,
            0.02,
            turnaround_scale * 0.92,
            88.0,
        ),
        descriptor(
            "brake-secondary",
            "brake",
            -preferred_side,
            0.90,
            1.34,
            0.52,
            -0.16,
            0.62,
            1.40,
            0.12,
            0.18,
            0.08,
            0.20,
            0.10,
            0.28,
            -0.02,
            braking_scale * 0.92,
            96.0,
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
const fn descriptor(
    id: &'static str,
    family: &'static str,
    side: i32,
    start_reach_scale: f64,
    end_reach_scale: f64,
    start_line_weight: f64,
    end_line_weight: f64,
    start_heading_weight: f64,
    end_heading_weight: f64,
    start_normal_scale: f64,
    end_normal_scale: f64,
    start_guide_normal_bias: f64,
    end_guide_normal_bias: f64,
    start_flow_weight: f64,
    end_flow_weight: f64,
    flow_shift: f64,
    arc_scale: f64,
    score_bias: f64,
) -> Descriptor {
    Descriptor {
        id,
        family,
        side,
        start_reach_scale,
        end_reach_scale,
        start_line_weight,
        end_line_weight,
        start_heading_weight,
        end_heading_weight,
        start_normal_scale,
        end_normal_scale,
        start_guide_normal_bias,
        end_guide_normal_bias,
        start_flow_weight,
        end_flow_weight,
        flow_shift,
        arc_scale,
        score_bias,
    }
}

fn preferred_turn_side(
    metrics: MotionMetrics,
    start_forward: CursorVector,
    end_forward: CursorVector,
) -> i32 {
    let start_delta = signed_angle(start_forward, metrics.direction);
    if start_delta.abs() > 0.16 {
        return if start_delta > 0.0 { 1 } else { -1 };
    }
    let end_delta = signed_angle(metrics.direction, end_forward);
    if end_delta.abs() > 0.18 {
        return if end_delta > 0.0 { -1 } else { 1 };
    }
    if metrics.dy.abs() > metrics.dx.abs() * 0.72 {
        return if metrics.dy > 0.0 { -1 } else { 1 };
    }
    if metrics.dx >= 0.0 {
        1
    } else {
        -1
    }
}

#[allow(clippy::too_many_arguments)]
fn resolved_guide(
    line: CursorVector,
    forward: CursorVector,
    normal: CursorVector,
    side_sign: f64,
    line_weight: f64,
    heading_weight: f64,
    normal_bias: f64,
) -> CursorVector {
    line.scaled(line_weight)
        .added(forward.scaled(heading_weight))
        .added(normal.scaled(normal_bias * side_sign))
        .normalized()
}

fn signed_angle(from: CursorVector, to: CursorVector) -> f64 {
    (from.x * to.y - from.y * to.x).atan2(from.x * to.x + from.y * to.y)
}

fn normalize_angle(mut angle: f64) -> f64 {
    while angle > PI {
        angle -= 2.0 * PI;
    }
    while angle < -PI {
        angle += 2.0 * PI;
    }
    angle
}

fn spring_progress_at(target_time: f64) -> f64 {
    let mut current = 0.0;
    let mut velocity = 0.0;
    let mut force = 0.0;
    let steps = ((target_time / SPRING_DT) - 1e-9).ceil().max(0.0) as usize;
    for _ in 0..steps {
        (current, velocity, force) = advance_spring(current, velocity, force);
    }
    current
}

pub fn spring_close_enough_time_seconds() -> f64 {
    let mut current = 0.0;
    let mut velocity = 0.0;
    let mut force = 0.0;
    for step in 1..=4_096 {
        (current, velocity, force) = advance_spring(current, velocity, force);
        if current >= 1.0 && (1.0 - current).abs() <= 0.01 {
            return f64::from(step) * SPRING_DT;
        }
    }
    1.43
}

pub fn cursor_motion_frame_points(
    start: CursorPoint,
    end: CursorPoint,
    bounds: CursorBounds,
    start_forward: CursorVector,
    end_forward: CursorVector,
    frame_interval_seconds: f64,
) -> Vec<CursorPoint> {
    let frame_interval = frame_interval_seconds.max(SPRING_DT);
    let duration = spring_close_enough_time_seconds();
    let motion = CursorMotion::new(start, end, bounds, start_forward, end_forward);
    let mut frames = Vec::new();
    let mut elapsed = frame_interval;
    while elapsed < duration {
        frames.push(motion.point_at_elapsed(elapsed));
        elapsed += frame_interval;
    }
    frames.push(end);
    frames
}

fn advance_spring(current: f64, velocity: f64, force: f64) -> (f64, f64, f64) {
    let stiffness = ((2.0 * PI) / SPRING_RESPONSE).powi(2).min(28_800.0);
    let drag = 2.0 * SPRING_DAMPING * stiffness.sqrt();
    let half_dt = SPRING_DT * 0.5;
    let velocity_half = velocity + force * half_dt;
    let next_current = current + velocity_half * SPRING_DT;
    let next_force = stiffness * (1.0 - next_current) - drag * velocity_half;
    let next_velocity = velocity_half + next_force * half_dt;
    (next_current, next_velocity, next_force)
}
